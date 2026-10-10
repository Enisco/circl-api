/**
 * Which member fields each role may edit (S10.2), as an allowlist.
 *
 * An allowlist and not a denylist, and never `...dto` into Prisma. The fields that must never be
 * editable through this endpoint — `status`, `isStaff`, roles, `onboardingCompleted`, anything on
 * `UserAuth` — are absent rather than listed, so a field added to the DTO tomorrow is not editable
 * until somebody writes it down here. A denylist would have made the new field editable by default
 * and the omission invisible.
 *
 * The same map answers two questions: what `PATCH admin/members/:id` accepts (§5.5) and what
 * `GET admin/members/:id/profile` reports as `editableFields` so the portal can grey out the rest.
 * One source, so the form and the endpoint cannot disagree — a form offering a field the API
 * refuses is a staff member typing a correction that silently never happens.
 */
const IDENTITY = ['firstName', 'lastName', 'username'] as const;
const CONTACT = ['email', 'phoneNumberDiallingCode', 'phoneNumber'] as const;
const DEMOGRAPHIC = [
  'cityId',
  'gender',
  'countryOfOriginCode',
  'heritageTag',
  'journeyStage',
  'languages',
  'interests',
] as const;
const PRESENCE = ['headline', 'bio', 'canHelpWith'] as const;

/** Everything a general administrator may correct. */
const FULL = [...IDENTITY, ...CONTACT, ...DEMOGRAPHIC, ...PRESENCE, 'removeAvatar'] as const;

export const MEMBER_EDITABLE_FIELDS: Record<string, readonly string[]> = {
  // Date of birth is locked once set (D10/D15). Only these two may correct it, and §5.5 narrows
  // that further to a `CORRECTION` or `LEGAL_GDPR` reason — an age is what gates Connect and the
  // adult sections, so an "edit" to it is a safeguarding change wearing a profile field's clothes.
  super_admin: [...FULL, 'dateOfBirth'],
  manager: [...FULL, 'dateOfBirth'],
  support: FULL,
  // Trust & Safety do not administer profiles. They get the avatar, and only because taking down
  // an abusive profile picture is moderation rather than editing — which is why it rides on
  // `content:moderate` rather than on `members:edit`.
  trust_safety: ['removeAvatar'],
};

/** What this caller may edit, which is their role's list and nothing inherited. */
export const editableFieldsFor = (roleCode: string): string[] => [
  ...(MEMBER_EDITABLE_FIELDS[roleCode] ?? []),
];

export const mayEditField = (roleCode: string, field: string): boolean =>
  (MEMBER_EDITABLE_FIELDS[roleCode] ?? []).includes(field);
