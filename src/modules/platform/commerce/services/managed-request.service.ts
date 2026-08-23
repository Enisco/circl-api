import { Injectable } from '@nestjs/common';
import {
  ManagedRequestSubject,
  SystemMessageType,
  TaxonomyKind,
  ThreadContextType,
  ThreadKind,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException } from '@/common';
import { TaxonomyService } from '../../shared';
import { ConversationFactoryService } from '../../messaging/services/conversation-factory.service';
import { ManagedRequestDto } from '../../professionals/dtos/booking.dto';

/**
 * `POST /managed-requests` (4.10).
 *
 * The "Want Circl to run your store?" upsell and the Professionals manual-
 * placement fallback are the same thing from the member's side: a request for
 * Circl's team to take something on. One resource, one team inbox.
 *
 * The seller's store, contact details and item count are attached server-side
 * from records already held, so the form asks for the areas they want help with
 * and nothing they have already told us.
 */
@Injectable()
export class ManagedRequestService {
  constructor(
    private readonly database: PrismaService,
    private readonly conversations: ConversationFactoryService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  async create(userId: string, dto: ManagedRequestDto) {
    if (dto.helpAreas?.length) {
      await this.taxonomy.assertAllValid(TaxonomyKind.STORE_HELP_AREA, dto.helpAreas, 'helpAreas');
    }

    const store =
      dto.subjectType === 'STOREFRONT'
        ? await this.database.store.findUnique({
            where: { ownerId: userId },
            include: { contacts: true, _count: { select: { items: true } } },
          })
        : null;

    if (dto.subjectType === 'PROFESSIONAL_PLACEMENT' && !dto.briefId) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'We need the brief you want us to place.',
        { details: [{ field: 'briefId', message: 'This is required.' }] },
      );
    }

    const staffIds = await this.conversations.staffUserIds();

    const result = await this.database.$transaction(async tx => {
      const { conversation, created } = await this.conversations.ensure(
        {
          kind: ThreadKind.SUPPORT,
          participantIds: [userId],
          staffIds,
          contextType: ThreadContextType.MANAGED_REQUEST,
          contextId: dto.storeId ?? dto.briefId ?? userId,
          snapshot: {
            title:
              dto.subjectType === 'STOREFRONT'
                ? 'Circl running your store'
                : 'Circl finding you someone',
          },
          isPinned: true,
        },
        tx,
      );

      const request = await tx.managedRequest.create({
        data: {
          userId,
          subjectType: dto.subjectType as ManagedRequestSubject,
          helpAreas: dto.helpAreas ?? undefined,
          notes: dto.notes ?? null,
          storeId: dto.storeId ?? store?.id ?? null,
          briefId: dto.briefId ?? null,
          conversationId: conversation.id,
        },
      });

      if (created) {
        await this.conversations.postSystemMessage(
          conversation.id,
          SystemMessageType.SUPPORT_OPENED,
          "Circl's team has your request. Only Circl staff can see this thread.",
          {
            managedRequestId: request.id,
            // Attached from records already held, so the member is not asked to
            // repeat what the store already says.
            ...(store
              ? {
                  storeId: store.id,
                  storeName: store.name,
                  itemCount: store._count.items,
                  contactChannels: store.contacts.map(contact => contact.channel),
                }
              : {}),
          },
          tx,
        );
      }

      return { request, conversationId: conversation.id };
    });

    return {
      id: result.request.id,
      subjectType: result.request.subjectType,
      state: result.request.state,
      conversationId: result.conversationId,
      createdAt: result.request.createdAt.toISOString(),
    };
  }
}
