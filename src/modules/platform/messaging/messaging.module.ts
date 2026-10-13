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
import { ThreadWorkService } from './services/thread-work.service';

/**
 * The conversation core every other section depends on — services only, **no controllers**.
 *
 * The split is not tidiness. `ADMIN_SURFACE_DEPENDENCIES` imports this module because the admin
 * inbox writes into a member's own thread, and while the controllers lived here `APP_SURFACE=admin`
 * mounted the entire member messaging API: sixteen routes on a host that is not supposed to answer
 * member requests. They did not even work there — the member JWT strategy is not registered on
 * that surface — so each one answered `500 Unknown authentication strategy "jwt"` rather than a
 * 404, which is the one status that pages somebody.
 *
 * `ModerationCoreModule` and `GuardCoreModule` are the pattern; this module carried the name
 * without the shape.
 */
@Global()
@Module({
  imports: [JwtModule.register({}), NotificationModule],
  providers: [
    ConversationFactoryService,
    ConversationService,
    MessageService,
    MessagePushService,
    PresenceRegistry,
    PresenceService,
    ThreadWorkService,
    ChatGateway,
  ],
  exports: [
    ConversationFactoryService,
    ConversationService,
    MessageService,
    PresenceRegistry,
    PresenceService,
    ThreadWorkService,
    ChatGateway,
  ],
})
export class MessagingCoreModule {}

/**
 * Section 5's member routes, which only the member surface mounts.
 *
 * The `RouterModule` registration has to name the module that declares the controllers, so it
 * moves here with them — otherwise the routes keep their `api/v1` prefix from a module that no
 * longer has them.
 */
@Module({
  imports: [
    MessagingCoreModule,
    RouterModule.register([
      {
        path: 'api/v1',
        module: MessagingModule,
        children: [MessagingController, PresenceController],
      },
    ]),
  ],
  controllers: [MessagingController, PresenceController],
  exports: [MessagingCoreModule],
})
export class MessagingModule {}
