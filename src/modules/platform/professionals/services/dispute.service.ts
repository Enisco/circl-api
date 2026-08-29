import { Injectable } from '@nestjs/common';
import {
  DisputeState,
  DisputeSubjectType,
  JobStage,
  JobState,
  SystemMessageType,
  ThreadContextType,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { addDays, ApiErrorCode, ApiException } from '@/common';
import { MediaService } from '../../shared';
import { ConversationFactoryService } from '../../messaging/services/conversation-factory.service';
import { CreateDisputeDto, DisputeEvidenceDto } from '../dtos/booking.dto';

export const DISPUTE_MEDIA_OWNER = 'DISPUTE';

/** What the screen can state plainly rather than promising nothing at all. */
const EXPECTED_RESOLUTION_DAYS = 5;

/** One dispute resource, shared by bookings and commerce enquiries (2.10, 4.1.3), so "Report a problem" behaves the same wherever it is raised. */
@Injectable()
export class DisputeService {
  constructor(
    private readonly database: PrismaService,
    private readonly conversations: ConversationFactoryService,
    private readonly media: MediaService,
  ) {}

  async openForBooking(userId: string, bookingId: string, dto: CreateDisputeDto) {
    const booking = await this.database.booking.findUnique({ where: { id: bookingId } });

    if (!booking) throw ApiException.notFound('That booking could not be found.');

    if (booking.clientId !== userId && booking.professionalId !== userId) {
      throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'This booking is not yours.');
    }

    return this.open(userId, dto, {
      subjectType: DisputeSubjectType.BOOKING,
      bookingId,
      conversationId: booking.conversationId,
      counterpartId: booking.clientId === userId ? booking.professionalId : booking.clientId,
      contextType: ThreadContextType.BOOKING,
      contextId: bookingId,
      onOpen: async tx => {
        await tx.booking.update({ where: { id: bookingId }, data: { state: JobState.DISPUTED } });
        await tx.bookingEvent.upsert({
          where: { bookingId_stage: { bookingId, stage: JobStage.DISPUTED } },
          update: { reachedAt: new Date() },
          create: { bookingId, stage: JobStage.DISPUTED, actorId: userId },
        });
      },
    });
  }

  async openForEnquiry(userId: string, enquiryId: string, dto: CreateDisputeDto) {
    const enquiry = await this.database.enquiry.findUnique({ where: { id: enquiryId } });

    if (!enquiry) throw ApiException.notFound('That order could not be found.');

    if (enquiry.buyerId !== userId && enquiry.sellerId !== userId) {
      throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'This order is not yours.');
    }

    return this.open(userId, dto, {
      subjectType: DisputeSubjectType.ORDER,
      enquiryId,
      conversationId: enquiry.conversationId,
      counterpartId: enquiry.buyerId === userId ? enquiry.sellerId : enquiry.buyerId,
      contextType: ThreadContextType.ORDER,
      contextId: enquiryId,
      onOpen: async tx => {
        await tx.enquiry.update({ where: { id: enquiryId }, data: { state: JobState.DISPUTED } });
        await tx.enquiryEvent.upsert({
          where: { enquiryId_stage: { enquiryId, stage: JobStage.DISPUTED } },
          update: { reachedAt: new Date() },
          create: { enquiryId, stage: JobStage.DISPUTED, actorId: userId },
        });
      },
    });
  }

  private async open(
    userId: string,
    dto: CreateDisputeDto,
    context: {
      subjectType: DisputeSubjectType;
      bookingId?: string;
      enquiryId?: string;
      conversationId: string | null;
      counterpartId: string;
      contextType: ThreadContextType;
      contextId: string;
      onOpen: (tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0]) => Promise<void>;
    },
  ) {
    // Either party may raise one.
    const existing = await this.database.dispute.findFirst({
      where: {
        ...(context.bookingId
          ? { bookingId: context.bookingId }
          : { enquiryId: context.enquiryId }),
        state: { in: [DisputeState.OPEN, DisputeState.IN_REVIEW] },
      },
    });

    if (existing) {
      throw ApiException.conflict(
        ApiErrorCode.DISPUTE_ALREADY_OPEN,
        'There is already an open issue on this.',
        {
          data: {
            dispute: {
              id: existing.id,
              state: existing.state,
              conversationId: existing.conversationId,
              expectedResolutionAt: existing.expectedResolutionAt?.toISOString() ?? null,
            },
          },
        },
      );
    }

    const media = await this.media.validate(dto.mediaKeys, userId);
    const staffIds = await this.conversations.staffUserIds();

    const dispute = await this.database.$transaction(async tx => {
      // Circl staff join the EXISTING thread rather than a new one being created (D29).
      let conversationId = context.conversationId;

      if (conversationId) {
        await this.conversations.addStaff(conversationId, staffIds, tx);
      } else {
        const { conversation } = await this.conversations.ensure(
          {
            kind: 'PROFESSIONAL',
            participantIds: [userId, context.counterpartId],
            staffIds,
            contextType: context.contextType,
            contextId: context.contextId,
          },
          tx,
        );

        conversationId = conversation.id;
      }

      const created = await tx.dispute.create({
        data: {
          subjectType: context.subjectType,
          bookingId: context.bookingId ?? null,
          enquiryId: context.enquiryId ?? null,
          raisedById: userId,
          reasonCode: dto.reasonCode,
          description: dto.description,
          conversationId,
          expectedResolutionAt: addDays(new Date(), EXPECTED_RESOLUTION_DAYS),
        },
      });

      await this.media.attach(tx, media, DISPUTE_MEDIA_OWNER, created.id);
      await context.onOpen(tx);

      await this.conversations.postSystemMessage(
        conversationId,
        SystemMessageType.DISPUTE_OPENED,
        'An issue was raised. This job is paused while Circl reviews it. Both of you can add evidence.',
        { disputeId: created.id },
        tx,
      );

      return created;
    });

    return {
      id: dispute.id,
      state: dispute.state,
      reasonCode: dispute.reasonCode,
      description: dispute.description,
      conversationId: dispute.conversationId,
      expectedResolutionAt: dispute.expectedResolutionAt?.toISOString() ?? null,
      createdAt: dispute.createdAt.toISOString(),
    };
  }

  /** One dispute, readable by either party. */
  async findOne(userId: string, disputeId: string) {
    const dispute = await this.database.dispute.findUnique({
      where: { id: disputeId },
      include: {
        booking: true,
        enquiry: true,
        evidence: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!dispute) throw ApiException.notFound('That issue could not be found.');

    if (!this.partiesOf(dispute).includes(userId)) {
      throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'This issue is not yours.');
    }

    return {
      id: dispute.id,
      subjectType: dispute.subjectType,
      subjectId: dispute.bookingId ?? dispute.enquiryId,
      reasonCode: dispute.reasonCode,
      description: dispute.description,
      state: dispute.state,
      conversationId: dispute.conversationId,
      expectedResolutionAt: dispute.expectedResolutionAt?.toISOString() ?? null,
      resolvedAt: dispute.resolvedAt?.toISOString() ?? null,
      evidence: dispute.evidence.map(item => ({
        id: item.id,
        submittedById: item.submittedById,
        isMine: item.submittedById === userId,
        note: item.note,
        createdAt: item.createdAt.toISOString(),
      })),
      viewer: {
        // Either party may keep adding until it closes (2.10).
        canAddEvidence:
          dispute.state === DisputeState.OPEN || dispute.state === DisputeState.IN_REVIEW,
      },
      createdAt: dispute.createdAt.toISOString(),
    };
  }

  private partiesOf(dispute: {
    booking: { clientId: string; professionalId: string } | null;
    enquiry: { buyerId: string; sellerId: string } | null;
  }): string[] {
    if (dispute.booking) return [dispute.booking.clientId, dispute.booking.professionalId];
    if (dispute.enquiry) return [dispute.enquiry.buyerId, dispute.enquiry.sellerId];

    return [];
  }

  /** "Both of you can add evidence" is promised on the screen, so it has to be true after submission and not only during (2.10). */
  async addEvidence(userId: string, disputeId: string, dto: DisputeEvidenceDto) {
    const dispute = await this.database.dispute.findUnique({
      where: { id: disputeId },
      include: { booking: true, enquiry: true },
    });

    if (!dispute) throw ApiException.notFound('That issue could not be found.');

    if (!this.partiesOf(dispute).includes(userId)) {
      throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'This issue is not yours.');
    }

    if (dispute.state === DisputeState.RESOLVED || dispute.state === DisputeState.WITHDRAWN) {
      throw ApiException.conflict(ApiErrorCode.CONFLICT, 'This issue has been closed.', {
        data: { state: dispute.state },
      });
    }

    const media = await this.media.validate(dto.mediaKeys, userId);

    const evidence = await this.database.$transaction(async tx => {
      const created = await tx.disputeEvidence.create({
        data: { disputeId, submittedById: userId, note: dto.note ?? null },
      });

      await this.media.attach(tx, media, DISPUTE_MEDIA_OWNER, created.id);

      return created;
    });

    return { id: evidence.id, createdAt: evidence.createdAt.toISOString() };
  }
}
