import { Injectable } from '@nestjs/common';
import { AuditArea, InternalNote, NoteSubjectType, Prisma } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException } from '@/common';
import { MediaService } from '@/modules/platform/shared';
import { AuditService } from '../audit/audit.service';
import { AdminPolicyService } from '../common/admin-policy.service';
import { AdminPrincipal } from '../common/admin-principal';
import { CreateNoteDto, PatchNoteDto } from '../dtos/admin-note.dto';
import { StaffRefView, toStaffRef } from '../serializers/admin-staff.serializer';

export interface InternalNoteView {
  id: string;
  subjectType: NoteSubjectType;
  subjectId: string;
  body: string;
  isPinned: boolean;
  author: StaffRefView | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Which permission lets somebody read — and therefore annotate — each kind of subject (§4.7).
 *
 * The note permission is the subject's read permission rather than one of its own. A note about a
 * safeguarding case is as sensitive as the case, and a separate `notes:write` would have been a
 * way to read the contents of cases you cannot open, one annotation at a time.
 */
const SUBJECT_PERMISSION: Record<NoteSubjectType, string> = {
  MEMBER: 'members:read',
  SUPPORT_THREAD: 'support:read',
  REPORT_CASE: 'reports:read',
  GUARD_CASE: 'guard:read',
  DISPUTE: 'disputes:manage',
  MANAGED_REQUEST: 'managed:manage',
  BRIEF: 'managed:manage',
  DEAL: 'disputes:manage',
  ESCALATION: 'reports:read',
};

/** The audit area a note takes, which is its subject's and not its own. */
const SUBJECT_AREA: Record<NoteSubjectType, AuditArea> = {
  MEMBER: AuditArea.MEMBERS,
  SUPPORT_THREAD: AuditArea.SUPPORT,
  REPORT_CASE: AuditArea.SAFETY,
  GUARD_CASE: AuditArea.SAFETY,
  DISPUTE: AuditArea.SUPPORT,
  MANAGED_REQUEST: AuditArea.SUPPORT,
  BRIEF: AuditArea.SUPPORT,
  DEAL: AuditArea.SUPPORT,
  ESCALATION: AuditArea.SAFETY,
};

/**
 * Staff notes about members, cases, threads, disputes and deals.
 *
 * One table and one pair of endpoints for every subject (§4.7). The alternative — a notes table
 * and a notes endpoint per section — is six copies of soft deletion, pinning, authorship and
 * "who may read this", and the copies drift: the first one to forget the author check is the one
 * that lets support edit a safeguarding note.
 *
 * Nothing here is ever visible to a member, which is why it is also audited: a judgement recorded
 * about somebody where they cannot see it needs a record of who recorded it.
 */
@Injectable()
export class AdminNoteService {
  constructor(
    private readonly database: PrismaService,
    private readonly audit: AuditService,
    private readonly media: MediaService,
    private readonly policy: AdminPolicyService,
  ) {}

  /** Pinned first, newest first inside each group — the order staff read them in. */
  async list(
    actor: AdminPrincipal,
    subjectType: NoteSubjectType,
    subjectId: string,
  ): Promise<InternalNoteView[]> {
    this.assertMayRead(actor, subjectType);
    await this.assertSubjectVisible(subjectType, subjectId);

    const notes = await this.database.internalNote.findMany({
      where: { subjectType, subjectId, deletedAt: null },
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });

    return this.serialise(notes);
  }

  async create(actor: AdminPrincipal, dto: CreateNoteDto): Promise<InternalNoteView> {
    this.assertMayRead(actor, dto.subjectType);
    await this.assertSubjectExists(dto.subjectType, dto.subjectId);

    const { result } = await this.audit.mutate<InternalNote>(
      (note: InternalNote) => ({
        action: 'note.created',
        area: SUBJECT_AREA[note.subjectType],
        targetType: note.subjectType,
        targetId: note.subjectId,
        after: { noteId: note.id, isPinned: note.isPinned, body: note.body },
      }),
      tx =>
        tx.internalNote.create({
          data: {
            subjectType: dto.subjectType,
            subjectId: dto.subjectId,
            authorId: actor.id,
            body: dto.body,
            isPinned: dto.isPinned ?? false,
          },
        }),
    );

    return (await this.serialise([result]))[0];
  }

  /**
   * Edits a note.
   *
   * The author, or somebody holding `team:manage`. Not whoever holds the subject's read permission
   * — a note is a person's own account of what they saw and why they acted, and a colleague
   * rewriting it leaves an entry attributed to the author that the author never wrote. `team:manage`
   * is the exception because somebody has to be able to redact a note that should not have been
   * written, and that edit is audited with both versions.
   */
  async patch(actor: AdminPrincipal, noteId: string, dto: PatchNoteDto): Promise<InternalNoteView> {
    const note = await this.find(noteId);

    this.assertMayRead(actor, note.subjectType);
    this.assertMayWrite(actor, note);

    if (dto.body === undefined && dto.isPinned === undefined) {
      throw ApiException.badRequest(ApiErrorCode.VALIDATION_FAILED, 'Nothing to change.');
    }

    const { result } = await this.audit.mutate<InternalNote>(
      {
        action: 'note.updated',
        area: SUBJECT_AREA[note.subjectType],
        targetType: note.subjectType,
        targetId: note.subjectId,
        before: { noteId: note.id, isPinned: note.isPinned, body: note.body },
        after: {
          noteId: note.id,
          isPinned: dto.isPinned ?? note.isPinned,
          body: dto.body ?? note.body,
        },
      },
      tx =>
        tx.internalNote.update({
          where: { id: noteId },
          data: {
            ...(dto.body === undefined ? {} : { body: dto.body }),
            ...(dto.isPinned === undefined ? {} : { isPinned: dto.isPinned }),
          },
        }),
    );

    return (await this.serialise([result]))[0];
  }

  /**
   * Soft-deletes a note.
   *
   * The row stays. A note is the record of a judgement somebody made about a person, and the fact
   * that it was written and then withdrawn is part of that record — a hard delete would leave the
   * audit entry pointing at nothing.
   */
  async remove(actor: AdminPrincipal, noteId: string): Promise<{ deleted: true }> {
    const note = await this.find(noteId);

    this.assertMayRead(actor, note.subjectType);
    this.assertMayWrite(actor, note);

    await this.audit.mutate(
      {
        action: 'note.deleted',
        area: SUBJECT_AREA[note.subjectType],
        targetType: note.subjectType,
        targetId: note.subjectId,
        before: { noteId: note.id, isPinned: note.isPinned, body: note.body },
      },
      tx =>
        tx.internalNote.update({
          where: { id: noteId },
          data: { deletedAt: new Date() },
        }),
    );

    return { deleted: true };
  }

  /** The pinned ones, for a detail page that shows them above everything else. */
  async pinned(subjectType: NoteSubjectType, subjectId: string): Promise<InternalNoteView[]> {
    const notes = await this.database.internalNote.findMany({
      where: { subjectType, subjectId, isPinned: true, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    return this.serialise(notes);
  }

  private async find(noteId: string): Promise<InternalNote> {
    const note = await this.database.internalNote.findFirst({
      where: { id: noteId, deletedAt: null },
    });

    if (!note) throw ApiException.notFound('No such note.');

    return note;
  }

  private assertMayRead(actor: AdminPrincipal, subjectType: NoteSubjectType): void {
    if (!actor.permissions.has(SUBJECT_PERMISSION[subjectType])) {
      throw ApiException.forbidden(
        ApiErrorCode.FORBIDDEN,
        'You do not have access to that kind of record.',
      );
    }
  }

  private assertMayWrite(actor: AdminPrincipal, note: InternalNote): void {
    if (note.authorId === actor.id || actor.permissions.has('team:manage')) return;

    throw ApiException.forbidden(
      ApiErrorCode.FORBIDDEN,
      'Only the author can change a note somebody else wrote.',
    );
  }

  /**
   * That the thing being annotated exists.
   *
   * The subject is a type and an id rather than a foreign key, so that a note survives its subject
   * being closed or anonymised — which means nothing stops a typo creating a note about nothing,
   * attached to a page nobody will ever open. Checked on write, where it is still fixable.
   *
   * Three subject types have no table yet (report cases, support threads and escalations arrive
   * with their sections). They are refused rather than accepted, because a note written against an
   * id that does not exist in a schema that will later define one is a note on the wrong record.
   */
  private async assertSubjectExists(
    subjectType: NoteSubjectType,
    subjectId: string,
  ): Promise<void> {
    await this.assertSubjectVisible(subjectType, subjectId);

    const exists = await this.subjectCount(subjectType, subjectId);

    if (exists === null) {
      throw ApiException.badRequest(
        ApiErrorCode.NOT_AVAILABLE_YET,
        `Notes on ${subjectType.toLowerCase().replace('_', ' ')}s arrive with that section.`,
      );
    }

    if (exists === 0) throw ApiException.notFound('No such record to make a note about.');
  }

  /**
   * R5, on the way in as well as on the way out.
   *
   * A note's subject is an id and a type, so `subjectType: MEMBER` with a **staff** id is a
   * well-formed request — and without this it was an answered one: the read path checked only the
   * caller's permission, so `admin/members/<staff id>/notes` and the generic endpoint both served
   * and accepted notes about a colleague, routing round Team entirely. An anonymised account went
   * the same way.
   *
   * Checked through the same `AdminPolicyService` the rest of the member surface uses, rather than
   * with a second query of its own, so there is one definition of who is a member.
   */
  private async assertSubjectVisible(
    subjectType: NoteSubjectType,
    subjectId: string,
  ): Promise<void> {
    if (subjectType === NoteSubjectType.MEMBER) await this.policy.assertIsMember(subjectId);
  }

  /** Null when the subject's table does not exist yet. */
  private async subjectCount(
    subjectType: NoteSubjectType,
    subjectId: string,
  ): Promise<number | null> {
    const where = { id: subjectId } satisfies { id: string };

    switch (subjectType) {
      case NoteSubjectType.MEMBER:
        // `assertSubjectVisible` has already applied R5; this is only "does the row exist".
        return this.database.user.count({ where: { id: subjectId } });
      case NoteSubjectType.GUARD_CASE:
        return this.database.guardThread.count({ where });
      case NoteSubjectType.DISPUTE:
        return this.database.dispute.count({ where });
      case NoteSubjectType.MANAGED_REQUEST:
        return this.database.managedRequest.count({ where });
      case NoteSubjectType.BRIEF:
        return this.database.managedBrief.count({ where });
      case NoteSubjectType.DEAL:
        return this.database.deal.count({ where });
      default:
        return null;
    }
  }

  /** Authors resolved in one query, so a page of notes is two reads rather than one per note. */
  private async serialise(notes: InternalNote[]): Promise<InternalNoteView[]> {
    if (!notes.length) return [];

    const authors = await this.database.user.findMany({
      where: { id: { in: [...new Set(notes.map(note => note.authorId))] } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        avatarKey: true,
        profileImageUrl: true,
        userRole: { select: { role: { select: { code: true } } } },
      },
    });

    const byId = new Map(authors.map(author => [author.id, author]));
    const sign = (key: string) => this.media.sign(key);

    return notes.map(note => {
      const author = byId.get(note.authorId);

      return {
        id: note.id,
        subjectType: note.subjectType,
        subjectId: note.subjectId,
        body: note.body,
        isPinned: note.isPinned,
        // Null where the staff account has since been deleted. The note stays: what was observed
        // does not stop being true because the observer left.
        author: author ? toStaffRef(author, sign) : null,
        createdAt: note.createdAt.toISOString(),
        updatedAt: note.updatedAt.toISOString(),
      };
    });
  }
}

/** Kept beside the service so a caller need not know the table's own column names. */
export const noteSubjectFilter = (
  subjectType: NoteSubjectType,
  subjectId: string,
): Prisma.InternalNoteWhereInput => ({ subjectType, subjectId, deletedAt: null });
