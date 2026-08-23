import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { RouterModule } from '@nestjs/core';
import { MessagingController } from './controllers/messaging.controller';
import { ChatGateway } from './gateway/chat.gateway';
import { ConversationFactoryService } from './services/conversation-factory.service';
import { ConversationService } from './services/conversation.service';
import { MessageService } from './services/message.service';

/**
 * Section 5, plus the conversation core every other section depends on.
 *
 * Global because rule 3 of spec 5.0 is that every section hands messaging a
 * conversationId rather than guessing one: bookings, enquiries, connection
 * requests, disputes and Guard threads all create their threads through the
 * factory here.
 */
@Global()
@Module({
  imports: [
    JwtModule.register({}),
    RouterModule.register([
      { path: 'api/v1', module: MessagingCoreModule, children: [MessagingController] },
    ]),
  ],
  controllers: [MessagingController],
  providers: [ConversationFactoryService, ConversationService, MessageService, ChatGateway],
  exports: [ConversationFactoryService, ConversationService, MessageService, ChatGateway],
})
export class MessagingCoreModule {}
