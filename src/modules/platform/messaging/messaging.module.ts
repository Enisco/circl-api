import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { RouterModule } from '@nestjs/core';
import { MessagingController } from './controllers/messaging.controller';
import { ChatGateway } from './gateway/chat.gateway';
import { ConversationFactoryService } from './services/conversation-factory.service';
import { ConversationService } from './services/conversation.service';
import { NotificationModule } from '@/modules/infrastructure/notification/notification.module';
import { MessagePushService } from './services/message-push.service';
import { MessageService } from './services/message.service';

/** Section 5, plus the conversation core every other section depends on. */
@Global()
@Module({
  imports: [
    JwtModule.register({}),
    NotificationModule,
    RouterModule.register([
      { path: 'api/v1', module: MessagingCoreModule, children: [MessagingController] },
    ]),
  ],
  controllers: [MessagingController],
  providers: [
    ConversationFactoryService,
    ConversationService,
    MessageService,
    MessagePushService,
    ChatGateway,
  ],
  exports: [ConversationFactoryService, ConversationService, MessageService, ChatGateway],
})
export class MessagingCoreModule {}
