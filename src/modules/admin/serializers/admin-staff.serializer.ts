import { UrlSigner, displayNameOf } from '@/modules/platform/shared';

/** A staff member, wherever a payload names who did something (§5.0 `StaffRef`). */
export interface StaffRefView {
  id: string;
  name: string;
  avatarUrl: string | null;
  role: string;
}

/** What a query must select to build one. */
export interface StaffRefSource {
  id: string;
  firstName: string;
  lastName: string | null;
  avatarKey?: string | null;
  profileImageUrl?: string | null;
  adminProfile?: { avatar: string | null } | null;
  userRole?: { role: { code: string } } | null;
}

/**
 * A staff reference.
 *
 * Staff avatars live on `AdminProfile.avatar` — a URL the portal supplies, not Circl media — so
 * there is usually nothing to sign. The member columns are read as a fallback because a staff
 * account can be a member account promoted by the bootstrap CLI, and then the only picture they
 * have is the one they uploaded as a member.
 *
 * `role` falls back to `unknown` rather than being omitted: a staff row with no role row is a
 * broken account, and a payload that silently drops the field hides it.
 */
export const toStaffRef = (source: StaffRefSource, sign: UrlSigner): StaffRefView => ({
  id: source.id,
  name: displayNameOf(source.firstName, source.lastName),
  avatarUrl:
    source.adminProfile?.avatar ??
    (source.avatarKey ? sign(source.avatarKey) : (source.profileImageUrl ?? null)),
  role: source.userRole?.role.code ?? 'unknown',
});

/** The select every `StaffRef` needs. */
export const staffRefSelect = {
  id: true,
  firstName: true,
  lastName: true,
  avatarKey: true,
  profileImageUrl: true,
  adminProfile: { select: { avatar: true } },
  userRole: { select: { role: { select: { code: true } } } },
} as const;
