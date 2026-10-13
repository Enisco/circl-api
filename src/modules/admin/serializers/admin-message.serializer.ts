import { MessageKind, ParticipantRole } from '@prisma/client';
import { MessageView } from '@/modules/platform/messaging';

/**
 * One message, as a staff member reads it (§5.6's `AdminMessage`).
 *
 * The admin thread endpoints were serving the **member app's** `MessageView`: newest first, with
 * `isMine` relative to the staff account, reactions, mentions, a `clientId` and no way to tell a
 * colleague's reply from the member's own words. The portal worked around all of it — sorting by
 * `sentAt` and treating any sender who was not the thread's member as Circl — which is a guess
 * that happens to be right today and would be wrong the first time two members share a thread.
 *
 * So this is the shape the spec asks for, and the differences are the point:
 *
 *  - **`sender.role`** says whether the words are the member's or Circl's, from the participant
 *    row rather than inferred from who is left over.
 *  - **Oldest first.** A conversation is read in the order it happened; the member app pages
 *    backwards from the newest because that is where its scroll starts.
 *  - **`deleted` and `reported` as booleans**, because what a reviewer needs to know is that a
 *    message was withdrawn, not when.
 *  - **No `isMine`, no reactions, no mentions, no `clientId`.** None of them means anything to a
 *    reader who is not a participant, and `isMine` relative to a staff account is actively
 *    misleading.
 */
export interface AdminMessageView {
  id: string;
  sender: {
    id: string;
    name: string;
    avatarUrl: string | null;
    /** `MEMBER`, `STAFF`, or null for a system message nobody sent. */
    role: ParticipantRole | null;
  } | null;
  kind: MessageKind;
  body: string | null;
  systemType: string | null;
  attachments: Array<{ mediaId: string; type: string; url: string | null }>;
  sentAt: string;
  editedAt: string | null;
  deleted: boolean;
  reported: boolean;
}

/**
 * The staff shape, from the member one plus the participant roles.
 *
 * `roles` is the conversation's own participant map. A sender who is not in it at all — a staff
 * member who replied and was then removed, or a member who left a group — comes back with a null
 * role rather than being guessed at: "we do not know which side this person was on" is a true
 * thing to say, and the alternative is calling them Circl because they are not the member.
 */
export const toAdminMessages = (
  messages: MessageView[],
  roles: Map<string, ParticipantRole>,
  reportedIds: ReadonlySet<string> = new Set(),
): AdminMessageView[] =>
  [...messages]
    // Oldest first. The underlying page reads newest-first for the member app's scroll, and a
    // reviewer reading a thread backwards has to reconstruct the conversation in their head.
    .sort((a, b) => (a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : a.id < b.id ? -1 : 1))
    .map(message => ({
      id: message.id,
      sender: message.sender
        ? {
            id: message.sender.id,
            name: message.sender.name ?? message.sender.displayName,
            avatarUrl: message.sender.avatarUrl ?? null,
            role: roles.get(message.sender.id) ?? null,
          }
        : null,
      kind: message.kind,
      // Empty for a withdrawn message, as the member sees it: the body is gone, and `deleted`
      // beside it is what says so. A reviewer who needs the words of a deleted message needs the
      // report snapshot, which is a different record kept for that purpose.
      body: message.body || null,
      systemType: message.systemType,
      attachments: message.attachments.map(attachment => ({
        mediaId: attachment.id,
        type: attachment.type,
        url: attachment.url ?? null,
      })),
      sentAt: message.sentAt,
      editedAt: message.editedAt,
      deleted: message.deletedAt !== null,
      reported: reportedIds.has(message.id),
    }));
