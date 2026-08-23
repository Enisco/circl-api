import { Global, Module } from '@nestjs/common';
import { ConversationFactoryService } from './services/conversation-factory.service';

/**
 * The conversation core, global because every section hands messaging a
 * conversationId rather than guessing one (rule 3 of spec 5.0): bookings,
 * enquiries, connection requests, disputes and Guard threads all create threads
 * through this.
 *
 * The inbox and chat endpoints are added in Section 5; this is the half those
 * sections depend on.
 */
@Global()
@Module({
  providers: [ConversationFactoryService],
  exports: [ConversationFactoryService],
})
export class MessagingCoreModule {}
