import { Injectable } from '@nestjs/common';
import {
  NoteSubjectType,
  Prisma,
  WebsiteSubmission,
  WebsiteSubmissionState,
  WebsiteSubmissionType,
} from '@prisma/client';
import { ApiErrorCode, ApiException, buildPageMeta } from '@/common';
import { PrismaService } from '@/infrastructure';
import { MediaService } from '@/modules/platform/shared';
import { AuditService } from '../audit/audit.service';
import { AdminPrincipal } from '../common/admin-principal';
import {
  ListWebsiteSubmissionsDto,
  OPEN_SUBMISSION_STATES,
  PatchWebsiteSubmissionDto,
} from '../dtos/admin-website-submission.dto';
import { MemberRefView, toMemberRef } from '../serializers/admin-member.serializer';
import { caseMemberSelect } from '../serializers/admin-report-case.serializer';
import { memberAdminUrl, supportAdminUrl } from '../serializers/admin-url';
import { AdminNoteService, InternalNoteView } from './admin-note.service';

/** Long enough to recognise a message by, not long enough to read one in a list. §5.0's 280. */
const EXCERPT = 280;

/**
 * The labels the website shows its visitors, so a staff list reads the same words they chose.
 *
 * Hard-coded rather than taxonomy terms: these are the website's own form options, not platform
 * vocabulary, and a taxonomy kind nobody can edit from the portal would imply they are editable.
 * The website owns the codes; this owns the English for them, and the two are checked against each
 * other by `website-submissions.e2e.cjs`.
 */
const CODE_LABELS: Record<string, string> = {
  // Contact topics
  GENERAL: 'General',
  ACCOUNT: 'My account',
  PROS_AND_SELLERS: 'Professionals and sellers',
  PARTNERSHIPS: 'Partnerships',
  PRESS: 'Press',
  // Suggestion areas
  COMMUNITY: 'Community',
  PROFESSIONALS: 'Professionals',
  CONNECT: 'Connect',
  COMMERCE: 'Commerce',
  SOMETHING_NEW: 'Something new',
  // Deletion reasons
  NOT_USING: 'I don’t use it any more',
  PRIVACY: 'I have privacy concerns',
  BAD_EXPERIENCE: 'I had a bad experience',
  OTHER_ACCOUNT: 'I have another account',
  OTHER: 'Something else',
};

/**
 * Which column holds the code, per type. Exactly one of the three is set on any row.
 *
 * A row carries `topic`, `area` or `reason` depending on what form it came from, and a card that
 * had to know which is which would be a switch in the portal as well as here. One `code` field
 * out, and this is the single place that knows where it came from.
 */
const codeOf = (row: {
  type: WebsiteSubmissionType;
  topic: string | null;
  area: string | null;
  reason: string | null;
}) =>
  row.type === WebsiteSubmissionType.CONTACT_MESSAGE
    ? row.topic
    : row.type === WebsiteSubmissionType.FEATURE_SUGGESTION
      ? row.area
      : row.reason;

const SUBMISSION_SELECT = {
  id: true,
  type: true,
  state: true,
  name: true,
  email: true,
  topic: true,
  area: true,
  reason: true,
  title: true,
  body: true,
  matchedUserId: true,
  checkedAt: true,
  completedAt: true,
  ipHash: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WebsiteSubmissionSelect;

type SubmissionRow = Prisma.WebsiteSubmissionGetPayload<{ select: typeof SUBMISSION_SELECT }>;

export interface WebsiteSubmissionRowView {
  id: string;
  type: WebsiteSubmissionType;
  state: WebsiteSubmissionState;
  name: string | null;
  email: string | null;
  /** Whichever of topic/area/reason this type carries. */
  code: string | null;
  codeLabel: string | null;
  title: string | null;
  excerpt: string | null;
  /**
   * `DELETION_REQUEST` only, and null until `checkedAt` — see the service docblock.
   *
   * `adminUrl` is **null once the account has been anonymised**, which is the normal end of this
   * workflow: the portal's member page 404s on an anonymised account (`assertIsMember`), so a path
   * would be a dead link on exactly the screen that just finished the job. Null means "render the
   * name as text, not a link", which is what `admin-url.ts` means by it everywhere else. The member
   * is still returned, with `isAnonymised: true`, because "this account existed and is now gone" is
   * the outcome somebody reading the record needs to see.
   */
  matchedMember: (MemberRefView & { adminUrl: string | null }) | null;
  checkedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  adminUrl: string | null;
}

export interface WebsiteSubmissionDetailView extends WebsiteSubmissionRowView {
  /** The whole thing, where the row carries 280 characters of it. */
  body: string | null;
  /** The first twelve characters of the salted hash: enough to group a burst, useless otherwise. */
  ipHashPrefix: string | null;
  /** Everything else this address has sent, so "is this a duplicate" is answerable. */
  others: Array<{
    id: string;
    type: WebsiteSubmissionType;
    state: WebsiteSubmissionState;
    createdAt: string;
  }>;
  notes: InternalNoteView[];
}

/**
 * §5.27: the three forms on the public website, as a queue.
 *
 * Until this shipped, a submission reached a human as an email to the team inbox and nothing
 * else — which is tolerable for a suggestion and not for the third form, because one of them is
 * "delete my account". An account deletion worked out of somebody's inbox has no state anybody
 * else can see, no record of who handled it, and no way to tell a duplicate from a second attempt.
 *
 * Reads open on `support:read` and writes on `support:manage`: this is the support inbox's job
 * under a different door, and the same people do it.
 *
 * **Nothing here deletes an account, and nothing here emails the address on the form.** A
 * deletion request is a request; the deletion itself is `POST admin/members/:id/anonymise`, which
 * needs `members:delete`, makes the staff member type the username, and audits the decision before
 * destroying anything. Keeping the two apart is deliberate: anybody can type anybody's address
 * into a public form, so the thing that acts has to be addressed by member id, not by what a
 * stranger typed.
 */
@Injectable()
export class AdminWebsiteSubmissionService {
  constructor(
    private readonly database: PrismaService,
    private readonly audit: AuditService,
    private readonly notes: AdminNoteService,
    private readonly media: MediaService,
  ) {}

  async list(query: ListWebsiteSubmissionsDto) {
    query.assertDepth();

    const states = query.state?.length ? query.state : OPEN_SUBMISSION_STATES;
    const where: Prisma.WebsiteSubmissionWhereInput = {
      state: { in: states },
      ...(query.type?.length ? { type: { in: query.type } } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { email: { contains: query.q, mode: 'insensitive' } },
              { title: { contains: query.q, mode: 'insensitive' } },
              { body: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, rows] = await this.database.$transaction([
      this.database.websiteSubmission.count({ where }),
      this.database.websiteSubmission.findMany({
        where,
        select: SUBMISSION_SELECT,
        orderBy: [{ createdAt: query.order === 'asc' ? 'asc' : 'desc' }],
        skip: (query.currentPage - 1) * query.size,
        take: query.size,
      }),
    ]);

    // Counted **unfiltered**, so a badge does not move as somebody switches tabs — the same rule
    // the support inbox's counts follow. Outside the transaction above because Prisma's `groupBy`
    // does not type inside a `$transaction` array, and two reads of a count that is deliberately
    // not filtered do not need to share the page's snapshot.
    const [byState, byType] = await Promise.all([
      this.database.websiteSubmission.groupBy({ by: ['state'], _count: { _all: true } }),
      this.database.websiteSubmission.groupBy({ by: ['type'], _count: { _all: true } }),
    ]);

    const members = await this.matchedMembers(rows);

    return {
      data: rows.map(row => this.toRow(row, members)),
      meta: buildPageMeta({ currentPage: query.currentPage, perPage: query.size }, total, {
        counts: tally(
          Object.values(WebsiteSubmissionState),
          byState.map(group => [group.state, group._count._all]),
        ),
        byType: tally(
          Object.values(WebsiteSubmissionType),
          byType.map(group => [group.type, group._count._all]),
        ),
      }),
    };
  }

  async findOne(actor: AdminPrincipal, id: string): Promise<WebsiteSubmissionDetailView> {
    const row = await this.load(id);
    const members = await this.matchedMembers([row]);

    const [others, notes] = await Promise.all([
      // Only where there is an address to group by. A suggestion sent without one is not "every
      // anonymous suggestion ever".
      row.email
        ? this.database.websiteSubmission.findMany({
            where: { email: row.email, id: { not: row.id } },
            select: { id: true, type: true, state: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 20,
          })
        : Promise.resolve([]),
      this.notes.list(actor, NoteSubjectType.WEBSITE_SUBMISSION, row.id),
    ]);

    return {
      ...this.toRow(row, members),
      body: row.body,
      // A prefix, not the hash. The whole value plus a known salt is a reversible address for
      // anybody who has both, and nothing on this screen needs more than "these three match".
      ipHashPrefix: row.ipHash ? row.ipHash.slice(0, 12) : null,
      others: others.map(other => ({
        id: other.id,
        type: other.type,
        state: other.state,
        createdAt: other.createdAt.toISOString(),
      })),
      notes,
    };
  }

  /**
   * Move it along, or write down what was done.
   *
   * `DONE` and `SPAM` are terminal. A reopened request is indistinguishable from a new one that
   * nobody has read, and the website has already told this person what to expect — so going back is
   * a 409 rather than a state nobody can reason about. If something really does need doing again,
   * the person sent a new request, or staff work it from the member's own page.
   */
  async patch(actor: AdminPrincipal, id: string, dto: PatchWebsiteSubmissionDto) {
    dto.assertSomethingToDo();

    const row = await this.load(id);

    if (dto.state && dto.state !== row.state) {
      if (TERMINAL.includes(row.state)) {
        throw ApiException.conflict(
          ApiErrorCode.INVALID_TRANSITION,
          `This was already marked ${row.state.toLowerCase()}. A request that needs working again is a new one.`,
        );
      }

      await this.audit.mutate<WebsiteSubmission>(
        updated => ({
          action: 'website_submission.state_changed',
          targetType: 'WEBSITE_SUBMISSION',
          targetId: updated.id,
          before: { state: row.state },
          after: { state: updated.state },
        }),
        tx =>
          tx.websiteSubmission.update({
            where: { id },
            data: {
              state: dto.state!,
              // Stamped here rather than left to whoever reads the audit trail: "when was this
              // finished" is a column the queue sorts and filters on.
              ...(dto.state === WebsiteSubmissionState.DONE ? { completedAt: new Date() } : {}),
            },
          }),
      );
    }

    // After the state change, so a note written alongside a refused transition is not filed about
    // something that did not happen.
    if (dto.note) {
      await this.notes.create(actor, {
        subjectType: NoteSubjectType.WEBSITE_SUBMISSION,
        subjectId: id,
        body: dto.note,
      });
    }

    return this.findOne(actor, id);
  }

  private async load(id: string): Promise<SubmissionRow> {
    const row = await this.database.websiteSubmission.findUnique({
      where: { id },
      select: SUBMISSION_SELECT,
    });

    if (!row) throw ApiException.notFound('No such submission.');

    return row;
  }

  /**
   * The accounts a batch of deletion requests matched, in one query.
   *
   * Read live rather than trusted from `matchedUserId` alone: the row records what the address
   * matched when it was checked, and what happened to that account since is the outcome of this
   * very workflow. A member who was hard-deleted drops out of the map and `matchedMember` is null;
   * one who was anonymised — the normal ending — comes back with `isAnonymised: true` and no
   * `adminUrl`, because their portal page 404s from that moment on.
   *
   * Anonymised accounts are deliberately **not** filtered out here. "No account matched this
   * address" and "the account matched and has since been deleted" are different answers, and only
   * the second one means the request was carried out.
   */
  private async matchedMembers(rows: Array<{ matchedUserId: string | null }>) {
    const ids = [...new Set(rows.map(row => row.matchedUserId).filter((id): id is string => !!id))];

    if (!ids.length) return new Map<string, MemberRefView>();

    const members = await this.database.user.findMany({
      where: { id: { in: ids } },
      select: caseMemberSelect,
    });

    return new Map(members.map(member => [member.id, toMemberRef(member, this.media.sign)]));
  }

  private toRow(row: SubmissionRow, members: Map<string, MemberRefView>): WebsiteSubmissionRowView {
    const code = codeOf(row);
    const member = row.matchedUserId ? members.get(row.matchedUserId) : undefined;

    return {
      id: row.id,
      type: row.type,
      state: row.state,
      name: row.name,
      email: row.email,
      code,
      codeLabel: code ? (CODE_LABELS[code] ?? code) : null,
      title: row.title,
      excerpt: row.body ? row.body.slice(0, EXCERPT) : null,
      matchedMember: member
        ? { ...member, adminUrl: member.isAnonymised ? null : memberAdminUrl(member.id) }
        : null,
      checkedAt: row.checkedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      adminUrl: supportAdminUrl('WEBSITE_SUBMISSION', row.id),
    };
  }
}

const TERMINAL: WebsiteSubmissionState[] = [
  WebsiteSubmissionState.DONE,
  WebsiteSubmissionState.SPAM,
];

/**
 * A `groupBy` result as an object with every key of that enum present.
 *
 * The keys are passed in rather than taken from both enums at once: `counts` is states and
 * `byType` is types, and one function filling in both would put `CONTACT_MESSAGE: 0` inside
 * `counts` — a key the portal would have to learn to ignore.
 *
 * Zeroes and not omissions, because a portal reading `counts.SPAM` to draw a badge should get `0`
 * rather than `undefined`, which renders as a blank where a zero belongs.
 */
const tally = (keys: string[], pairs: Array<[string, number]>): Record<string, number> => {
  const base: Record<string, number> = {};

  for (const key of keys) base[key] = 0;
  for (const [key, count] of pairs) base[key] = count;

  return base;
};
