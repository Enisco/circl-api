/**
 * Messaging's public surface.
 *
 * What other modules — and the admin API in particular — are allowed to depend on. A deep import
 * into `services/message.service` couples a caller to this module's file layout; this barrel is
 * the seam, so if messaging is ever reorganised, or the admin API becomes a separate service that
 * reaches it over HTTP, there is one list of things that has to keep working.
 */
export { MessagingCoreModule } from './messaging.module';
export { ConversationFactoryService } from './services/conversation-factory.service';
export { ConversationService } from './services/conversation.service';
export { MessageService } from './services/message.service';
export { ListMessagesDto, SendMessageDto } from './dtos/message.dto';
