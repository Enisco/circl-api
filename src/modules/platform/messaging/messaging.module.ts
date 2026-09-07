import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { RouterModule } from '@nestjs/core';
import { MessagingController } from './controllers/messaging.controller';
import { PresenceController } from './controllers/presence.controller';
import { ChatGateway } from './gateway/chat.gateway';
import { ConversationFactoryService } from './services/conversation-factory.service';
import { ConversationService } from './services/conversation.service';
import { NotificationModule } from '@/modules/infrastructure/notification/notification.module';
import { MessagePushService } from './services/message-push.service';
import { MessageService } from './services/message.service';
import { PresenceRegistry } from './services/presence.registry';
import { PresenceService } from './services/presence.service';

/** Section 5, plus the conversation core every other section depends on. */
@Global()
@Module({
  imports: [
    JwtModule.register({}),
    NotificationModule,
    RouterModule.register([
      {
        path: 'api/v1',
        module: MessagingCoreModule,
        children: [MessagingController, PresenceController],
      },
    ]),
  ],
  controllers: [MessagingController, PresenceController],
  providers: [
    ConversationFactoryService,
    ConversationService,
    MessageService,
    MessagePushService,
    PresenceRegistry,
    PresenceService,
    ChatGateway,
  ],
  exports: [
    ConversationFactoryService,
    ConversationService,
    MessageService,
    PresenceRegistry,
    PresenceService,
    ChatGateway,
  ],
})
export class MessagingCoreModule {}
