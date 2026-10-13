/** The UPPER_SNAKE codes in `error.code` (spec 0.4). */
export const ApiErrorCode = {
  // ─── Generic ───────────────────────────────────────────────────────────────
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  /** A deleted post returns 404 with this rather than disappearing from a list silently, so the client can render a tombstone where the user tapped (0.4). */
  RESOURCE_DELETED: 'RESOURCE_DELETED',

  /** The first call with this `Idempotency-Key` has not finished yet, so this one is a duplicate of something already in flight (0.12). Carries no result: there is not one yet. */
  IDEMPOTENT_REQUEST_IN_PROGRESS: 'IDEMPOTENT_REQUEST_IN_PROGRESS',

  // ─── Account deletion (0.15) ───────────────────────────────────────────────
  ACCOUNT_ALREADY_DELETED: 'ACCOUNT_ALREADY_DELETED',
  INVALID_CODE: 'INVALID_CODE',

  // ─── Media (0.11) ──────────────────────────────────────────────────────────
  MEDIA_NOT_FOUND: 'MEDIA_NOT_FOUND',
  MEDIA_ALREADY_ATTACHED: 'MEDIA_ALREADY_ATTACHED',
  // §2.9: the supporting documents a gated profession has to show.
  DOCUMENTS_REQUIRED: 'DOCUMENTS_REQUIRED',
  PROFESSION_LOCKED: 'PROFESSION_LOCKED',
  TOO_MANY_DOCUMENTS: 'TOO_MANY_DOCUMENTS',
  /// Sent for a profession that needs none. Refused rather than ignored: these are qualification
  /// and identity papers, and the platform does not keep ones it has no reason to hold.
  DOCUMENTS_NOT_REQUIRED: 'DOCUMENTS_NOT_REQUIRED',
  DOCUMENT_NOT_USABLE: 'DOCUMENT_NOT_USABLE',
  DOCUMENT_SCANNING: 'DOCUMENT_SCANNING',
  DOCUMENT_REMOVED: 'DOCUMENT_REMOVED',
  MEDIA_TYPE_NOT_ALLOWED: 'MEDIA_TYPE_NOT_ALLOWED',
  MEDIA_TOO_LARGE: 'MEDIA_TOO_LARGE',
  MEDIA_MIXED_TYPES: 'MEDIA_MIXED_TYPES',
  MEDIA_LIMIT_EXCEEDED: 'MEDIA_LIMIT_EXCEEDED',
  MEDIA_NOT_READY: 'MEDIA_NOT_READY',
  PREFERENCE_LOCKED: 'PREFERENCE_LOCKED',
  USERNAME_TAKEN: 'USERNAME_TAKEN',

  // ─── Taxonomy ──────────────────────────────────────────────────────────────
  UNKNOWN_TAXONOMY_CODE: 'UNKNOWN_TAXONOMY_CODE',
  UNKNOWN_CITY: 'UNKNOWN_CITY',

  // ─── Section 1: Community ──────────────────────────────────────────────────
  USE_PRIVATE_ENDPOINT: 'USE_PRIVATE_ENDPOINT',
  REQUEST_NOT_EDITABLE: 'REQUEST_NOT_EDITABLE',
  REQUEST_ALREADY_RESOLVED: 'REQUEST_ALREADY_RESOLVED',
  REQUEST_CLOSED: 'REQUEST_CLOSED',
  NOT_A_RESPONDER: 'NOT_A_RESPONDER',
  ALREADY_OFFERED: 'ALREADY_OFFERED',
  CANNOT_OFFER_ON_OWN_REQUEST: 'CANNOT_OFFER_ON_OWN_REQUEST',
  COMMENTS_DISABLED: 'COMMENTS_DISABLED',
  GROUP_NAME_TAKEN: 'GROUP_NAME_TAKEN',
  NOT_A_MEMBER: 'NOT_A_MEMBER',
  LAST_ADMIN_CANNOT_LEAVE: 'LAST_ADMIN_CANNOT_LEAVE',
  /// Final until an invitation: a removed member cannot ask again (1.7.6).
  REMOVED_FROM_GROUP: 'REMOVED_FROM_GROUP',
  /// A member doing an admin's job. Its own code so the client can say whose job it is.
  NOT_ADMIN: 'NOT_ADMIN',
  ALREADY_A_MEMBER: 'ALREADY_A_MEMBER',
  GUIDE_PROVENANCE_REQUIRED: 'GUIDE_PROVENANCE_REQUIRED',

  // ─── Section 2: Professionals ──────────────────────────────────────────────
  LISTING_ALREADY_EXISTS: 'LISTING_ALREADY_EXISTS',
  LISTING_NOT_FOUND: 'LISTING_NOT_FOUND',
  OFFER_ALREADY_PROMOTED: 'OFFER_ALREADY_PROMOTED',
  NOT_ACCEPTING_WORK: 'NOT_ACCEPTING_WORK',
  SERVICE_INACTIVE: 'SERVICE_INACTIVE',
  CANNOT_BOOK_YOURSELF: 'CANNOT_BOOK_YOURSELF',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  VERIFICATION_INCOMPLETE: 'VERIFICATION_INCOMPLETE',
  DISPUTE_ALREADY_OPEN: 'DISPUTE_ALREADY_OPEN',
  NOT_A_PROFESSIONAL: 'NOT_A_PROFESSIONAL',
  REVIEW_ALREADY_LEFT: 'REVIEW_ALREADY_LEFT',
  REVIEW_NOT_ELIGIBLE: 'REVIEW_NOT_ELIGIBLE',
  REVIEW_FROZEN: 'REVIEW_FROZEN',
  CANNOT_REVIEW_YOURSELF: 'CANNOT_REVIEW_YOURSELF',

  // ─── Section 3: Connect ────────────────────────────────────────────────────
  CONNECT_PROFILE_REQUIRED: 'CONNECT_PROFILE_REQUIRED',
  UNDER_MINIMUM_AGE: 'UNDER_MINIMUM_AGE',
  DOB_LOCKED: 'DOB_LOCKED',
  DOB_REQUIRED: 'DOB_REQUIRED',
  DATING_CONFIRMATION_REQUIRED: 'DATING_CONFIRMATION_REQUIRED',
  REQUEST_ALREADY_EXISTS: 'REQUEST_ALREADY_EXISTS',
  DIRECT_MESSAGE_ALLOWED: 'DIRECT_MESSAGE_ALLOWED',
  REQUEST_COOLDOWN: 'REQUEST_COOLDOWN',
  CANNOT_CONNECT_WITH_YOURSELF: 'CANNOT_CONNECT_WITH_YOURSELF',
  /// Nine posts per profile, five photos per photo post, one video per video post (3.2.2).
  CONNECT_POST_LIMIT: 'CONNECT_POST_LIMIT',
  /// Past sixty seconds. Its own code so the client can put the refusal in front of the member.
  CONNECT_VIDEO_TOO_LONG: 'CONNECT_VIDEO_TOO_LONG',
  /// A video with no poster is a grey square, so the frame is required rather than hoped for.
  CONNECT_POSTER_REQUIRED: 'CONNECT_POSTER_REQUIRED',
  /// Ten live stories per person. A story layer with no ceiling becomes a feed nobody asked for.
  CONNECT_STORY_LIMIT: 'CONNECT_STORY_LIMIT',
  /// Past `limits.maxHobbies`. Its own code, with the limit in `data`, because the cap is
  /// configuration rather than a decorator and the client is told what it actually is.
  TOO_MANY_HOBBIES: 'TOO_MANY_HOBBIES',
  /// A profile being **created** arrived with fewer than `limits.minConnectPhotos` photo keys.
  /// Never raised by an edit: a profile from before the rule keeps its place.
  CONNECT_PHOTOS_REQUIRED: 'CONNECT_PHOTOS_REQUIRED',
  /// v2 §2: a profile needs `limits.minHobbies` of them to be created.
  CONNECT_HOBBIES_REQUIRED: 'CONNECT_HOBBIES_REQUIRED',
  /// v2 §1: a card photo id that is not a photo on one of this profile's own posts.
  UNKNOWN_MEDIA: 'UNKNOWN_MEDIA',
  /// A profile being **created** arrived with no answered prompt. A card with a name, a photo and
  /// nothing said is the profile people scroll past, and the one nobody can open a conversation
  /// about. Also never raised by an edit, for the same reason.
  CONNECT_PROMPT_REQUIRED: 'CONNECT_PROMPT_REQUIRED',
  /// Outside `limits.minPromptAnswer`..`maxPromptAnswer`. On a card an answer is a sentence.
  PROMPT_ANSWER_LENGTH: 'PROMPT_ANSWER_LENGTH',

  // ─── Section 4: Commerce ───────────────────────────────────────────────────
  STORE_ALREADY_EXISTS: 'STORE_ALREADY_EXISTS',
  STORE_NOT_FOUND: 'STORE_NOT_FOUND',
  STORE_CLOSED: 'STORE_CLOSED',
  ITEMS_UNAVAILABLE: 'ITEMS_UNAVAILABLE',
  DELIVERY_NOT_OFFERED: 'DELIVERY_NOT_OFFERED',
  // Its sibling, which only became expressible once a shop could say DELIVERY and mean only that.
  COLLECTION_NOT_OFFERED: 'COLLECTION_NOT_OFFERED',
  CANNOT_ENQUIRE_OWN_STORE: 'CANNOT_ENQUIRE_OWN_STORE',
  NOT_A_SELLER: 'NOT_A_SELLER',

  // ─── Section 5: Messaging ──────────────────────────────────────────────────
  CONVERSATION_BLOCKED: 'CONVERSATION_BLOCKED',
  NOT_A_PARTICIPANT: 'NOT_A_PARTICIPANT',
  MESSAGE_DELETE_WINDOW_PASSED: 'MESSAGE_DELETE_WINDOW_PASSED',
  /// Its own code, so the client can tell "too late" from a generic refusal.
  EDIT_WINDOW_CLOSED: 'EDIT_WINDOW_CLOSED',
  /// Replying to, reacting to or forwarding something that is not in this thread.
  MESSAGE_NOT_IN_CONVERSATION: 'MESSAGE_NOT_IN_CONVERSATION',
  CANNOT_MESSAGE_YOURSELF: 'CANNOT_MESSAGE_YOURSELF',

  // ─── Account: sessions, email, export, privacy (BACKEND-DATA-GAPS) ─────────
  CANNOT_REVOKE_CURRENT_SESSION: 'CANNOT_REVOKE_CURRENT_SESSION',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  CODE_EXPIRED: 'CODE_EXPIRED',
  EXPORT_ALREADY_PENDING: 'EXPORT_ALREADY_PENDING',

  // ═══ Admin portal ═══════════════════════════════════════════════════════════
  //
  // ─── Staff authentication ──────────────────────────────────────────────────
  /// Every login failure, whatever the cause: unknown email, non-staff account, deactivated
  /// account, wrong password, locked account, MFA not enrolled. One body and one timing, because
  /// telling an attacker which of those it was tells them whose inbox to go after next.
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  MFA_TOKEN_INVALID: 'MFA_TOKEN_INVALID',
  SESSION_REVOKED: 'SESSION_REVOKED',
  MFA_ALREADY_ENROLLED: 'MFA_ALREADY_ENROLLED',
  PASSWORD_POLICY: 'PASSWORD_POLICY',
  /// One code for every invalid invite state — unknown, expired, used, revoked, superseded — so
  /// the response cannot be used to discover which addresses have been invited.
  INVITE_INVALID: 'INVITE_INVALID',
  RESEND_LIMIT: 'RESEND_LIMIT',
  /// The admin surface is answered with 404 rather than 403 when the trusted-client credential is
  /// missing: a 403 confirms the route exists.
  BFF_REQUIRED: 'BFF_REQUIRED',

  // ─── Object-level rules (§3.6) ─────────────────────────────────────────────
  TARGET_PROTECTED: 'TARGET_PROTECTED',
  LAST_SUPER_ADMIN: 'LAST_SUPER_ADMIN',
  CANNOT_ACT_ON_SELF: 'CANNOT_ACT_ON_SELF',
  ROLE_ESCALATION_FORBIDDEN: 'ROLE_ESCALATION_FORBIDDEN',
  APPEAL_REVIEWER_CONFLICT: 'APPEAL_REVIEWER_CONFLICT',

  // ─── Admin mutations ───────────────────────────────────────────────────────
  REASON_REQUIRED: 'REASON_REQUIRED',
  REASON_NOT_ALLOWED: 'REASON_NOT_ALLOWED',
  FIELD_NOT_EDITABLE: 'FIELD_NOT_EDITABLE',
  ALREADY_DECIDED: 'ALREADY_DECIDED',
  CLAIMED_BY_OTHER: 'CLAIMED_BY_OTHER',
  CLAIM_REQUIRED: 'CLAIM_REQUIRED',
  INVALID_DECISION: 'INVALID_DECISION',
  MEMBER_MESSAGE_REQUIRED: 'MEMBER_MESSAGE_REQUIRED',
  ALREADY_SUSPENDED: 'ALREADY_SUSPENDED',
  CONFIRMATION_MISMATCH: 'CONFIRMATION_MISMATCH',
  RESTORE_NOT_ALLOWED: 'RESTORE_NOT_ALLOWED',
  IMMUTABLE_FIELD: 'IMMUTABLE_FIELD',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  JOB_ALREADY_RUNNING: 'JOB_ALREADY_RUNNING',
  /** A job somebody ran by hand did its work and failed. The message is the run's own error. */
  JOB_FAILED: 'JOB_FAILED',

  // ─── Private threads and PII ───────────────────────────────────────────────
  THREAD_ACCESS_REQUIRED: 'THREAD_ACCESS_REQUIRED',
  LINK_REQUIRED: 'LINK_REQUIRED',
  USE_SUPPORT_INBOX: 'USE_SUPPORT_INBOX',

  // ─── Enforcement and appeals ───────────────────────────────────────────────
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  APPEAL_WINDOW_CLOSED: 'APPEAL_WINDOW_CLOSED',
  APPEAL_SUBJECT_INVALID: 'APPEAL_SUBJECT_INVALID',

  // ─── Lists, analytics and exports ──────────────────────────────────────────
  PAGE_TOO_DEEP: 'PAGE_TOO_DEEP',
  FILTER_RANGE_TOO_LARGE: 'FILTER_RANGE_TOO_LARGE',
  ANALYTICS_TIMEOUT: 'ANALYTICS_TIMEOUT',
  // `UNKNOWN_CITY` and `UNKNOWN_TAXONOMY_CODE` already exist above and are reused here: 400 in a
  // filter (query validation), 422 on an edit (a well-formed request breaking a rule).
  EXPORT_LIMIT: 'EXPORT_LIMIT',
  NOT_READY: 'NOT_READY',
  LINK_EXPIRED: 'LINK_EXPIRED',

  // ─── Communications ────────────────────────────────────────────────────────
  STALE_AUDIENCE: 'STALE_AUDIENCE',
  AUDIENCE_TOO_SMALL: 'AUDIENCE_TOO_SMALL',

  // ─── Idempotency (§2.9) ────────────────────────────────────────────────────
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',

  // ─── Shipping in a later milestone ─────────────────────────────────────────
  /// A request field whose pipeline has not shipped. Deliberately only ever a 400 on a request
  /// field: a chart that cannot be computed returns 200 and says so inside the payload, because
  /// one absent future feature must not fail a whole dashboard.
  NOT_AVAILABLE_YET: 'NOT_AVAILABLE_YET',
  APP_UPDATE_REQUIRED: 'APP_UPDATE_REQUIRED',
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];
