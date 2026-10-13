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
/** The member-facing message shape, published so the admin serialiser can map off it (§5.6). */
export type { MessageView } from './services/message.service';
export { ListMessagesDto, SendMessageDto } from './dtos/message.dto';
/**
 * §7.6's rules, published because the admin inbox has to apply the same ones. `waitingSince` in
 * particular is used by §5.15 to serialise what `MessageService` stored — one definition of "this
 * person is waiting on us", on both sides of the seam.
 */
export {
  settledType,
  stateAfterMessage,
  typeFromContext,
  waitingSince,
} from './services/support-thread.rules';
export type { StateChange } from './services/support-thread.rules';
