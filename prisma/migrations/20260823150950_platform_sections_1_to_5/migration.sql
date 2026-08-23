-- Circl Intelligence relies on trigram similarity for guide matching (1.6.5) and
-- for the `q` free-text filters across every section. Postgres ships it; we just
-- have to ask for it. This is deliberately not an embedding model: the match has
-- to answer in under 400ms while a member waits to post (1.6.5).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateEnum
CREATE TYPE "TaxonomyKind" AS ENUM ('COMMUNITY_CATEGORY', 'GUIDE_TOPIC', 'PROFESSION', 'HERITAGE_TAG', 'JOURNEY_STAGE', 'INTEREST', 'LANGUAGE', 'COUNTRY_OF_ORIGIN', 'CONNECTION_TYPE', 'ITEM_CATEGORY', 'ITEM_UNIT', 'ITEM_PRICE_BAND', 'STORE_TYPE', 'STORE_CONTACT_CHANNEL', 'STORE_HELP_AREA', 'HELP_TAG');

-- CreateEnum
CREATE TYPE "PostVisibility" AS ENUM ('PUBLIC', 'ANONYMOUS', 'PRIVATE_TO_CIRCL');

-- CreateEnum
CREATE TYPE "DeliveryMode" AS ENUM ('IN_PERSON', 'ONLINE', 'BOTH');

-- CreateEnum
CREATE TYPE "PriceBasis" AS ENUM ('PER_HOUR', 'PER_JOB', 'PER_DAY', 'NEGOTIABLE');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('PENDING', 'UPLOADED', 'ATTACHED', 'FAILED');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('OPEN', 'RESOLVED', 'CLOSED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RequestOutcome" AS ENUM ('HELPED', 'SOLVED_ELSEWHERE', 'NO_LONGER_NEEDED');

-- CreateEnum
CREATE TYPE "FeedItemType" AS ENUM ('REQUEST', 'OFFER', 'UPDATE', 'GUIDE');

-- CreateEnum
CREATE TYPE "FeedFeedbackReason" AS ENUM ('NOT_RELEVANT', 'WRONG_CITY', 'SEEN_TOO_MUCH', 'OTHER');

-- CreateEnum
CREATE TYPE "GuideBlockType" AS ENUM ('HEADING', 'PARAGRAPH', 'STEP');

-- CreateEnum
CREATE TYPE "GuideSourceType" AS ENUM ('REQUEST', 'REQUEST_RESPONSE', 'GUIDE');

-- CreateEnum
CREATE TYPE "DeflectionOutcome" AS ENUM ('ANSWERED', 'POSTED_ANYWAY');

-- CreateEnum
CREATE TYPE "JoinPolicy" AS ENUM ('OPEN', 'APPROVAL');

-- CreateEnum
CREATE TYPE "GroupMembershipState" AS ENUM ('PENDING', 'MEMBER', 'ADMIN', 'REJECTED', 'REMOVED');

-- CreateEnum
CREATE TYPE "ReportTargetType" AS ENUM ('REQUEST', 'RESPONSE', 'OFFER', 'UPDATE', 'UPDATE_REPLY', 'GUIDE', 'GROUP', 'GROUP_POST', 'GROUP_POST_REPLY', 'MESSAGE', 'CONVERSATION', 'STORE', 'STORE_ITEM', 'CONNECT_PROFILE', 'PROFESSIONAL_LISTING', 'USER');

-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('SPAM', 'HARASSMENT', 'SCAM', 'INAPPROPRIATE', 'IMPERSONATION', 'SAFETY_CONCERN', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportState" AS ENUM ('RECEIVED', 'TRIAGED', 'ACTIONED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ModerationDecision" AS ENUM ('APPROVE', 'REJECT', 'REMOVE_CONTENT', 'WARN_AUTHOR', 'SUSPEND_AUTHOR', 'NO_ACTION');

-- CreateEnum
CREATE TYPE "ModerationQueueType" AS ENUM ('ANONYMOUS_POST', 'REPORTED_CONTENT', 'GUARD_RISK', 'AUTO_GUIDE', 'MANAGED_REQUEST');

-- CreateEnum
CREATE TYPE "ModerationQueueState" AS ENUM ('PENDING', 'IN_REVIEW', 'RESOLVED');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "RiskCategory" AS ENUM ('SELF_HARM', 'DOMESTIC_ABUSE', 'DEPORTATION_RISK', 'SCAM', 'LANDLORD_FRAUD', 'EXPLOITATION', 'MODERN_SLAVERY', 'HATE', 'RESTRICTED_ITEM', 'UNVERIFIED_CREDENTIAL', 'OTHER');

-- CreateEnum
CREATE TYPE "GuardThreadState" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TrustCheckType" AS ENUM ('EMAIL', 'IDENTITY', 'RIGHT_TO_WORK', 'CREDENTIAL');

-- CreateEnum
CREATE TYPE "TrustCheckStatus" AS ENUM ('NOT_STARTED', 'SUBMITTED', 'IN_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ReviewContext" AS ENUM ('COMMUNITY', 'BOOKING', 'ORDER', 'PRIOR_WORK');

-- CreateEnum
CREATE TYPE "ExperienceLevel" AS ENUM ('BEGINNER', 'MID_LEVEL', 'EXPERT');

-- CreateEnum
CREATE TYPE "ListingVerificationStatus" AS ENUM ('DRAFT', 'UNVERIFIED', 'SUBMITTED', 'IN_REVIEW', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BriefUrgency" AS ENUM ('ASAP', 'THIS_WEEK', 'THIS_MONTH', 'FLEXIBLE');

-- CreateEnum
CREATE TYPE "BriefState" AS ENUM ('DRAFT', 'OPEN', 'MATCHED', 'PLACED', 'CLOSED');

-- CreateEnum
CREATE TYPE "JobState" AS ENUM ('PENDING_ACCEPTANCE', 'ACCEPTED', 'IN_PROGRESS', 'DELIVERED', 'CHANGES_REQUESTED', 'COMPLETED', 'CANCELLED', 'DISPUTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "JobStage" AS ENUM ('REQUESTED', 'ACCEPTED', 'IN_PROGRESS', 'DELIVERED', 'CHANGES_REQUESTED', 'DONE', 'REVIEWED', 'CANCELLED', 'DISPUTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BookingMode" AS ENUM ('ONLINE', 'IN_PERSON');

-- CreateEnum
CREATE TYPE "DisputeSubjectType" AS ENUM ('BOOKING', 'ORDER');

-- CreateEnum
CREATE TYPE "DisputeReason" AS ENUM ('NOT_DELIVERED', 'NOT_AS_DESCRIBED', 'QUALITY', 'COMMUNICATION', 'OTHER');

-- CreateEnum
CREATE TYPE "DisputeState" AS ENUM ('OPEN', 'IN_REVIEW', 'RESOLVED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ManagedRequestSubject" AS ENUM ('STOREFRONT', 'PROFESSIONAL_PLACEMENT');

-- CreateEnum
CREATE TYPE "ManagedRequestState" AS ENUM ('OPEN', 'IN_PROGRESS', 'CLOSED');

-- CreateEnum
CREATE TYPE "DmPolicy" AS ENUM ('OPEN', 'REQUEST_FIRST');

-- CreateEnum
CREATE TYPE "ConnectionRequestState" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StoreStatus" AS ENUM ('OPEN', 'CLOSED', 'HOLIDAY');

-- CreateEnum
CREATE TYPE "StoreComplianceState" AS ENUM ('ACTIVE', 'UNDER_REVIEW', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "Weekday" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- CreateEnum
CREATE TYPE "Fulfilment" AS ENUM ('DELIVERY', 'COLLECTION');

-- CreateEnum
CREATE TYPE "ThreadKind" AS ENUM ('COMMUNITY', 'PROFESSIONAL', 'CONNECT', 'COMMERCE', 'SUPPORT', 'DIRECT');

-- CreateEnum
CREATE TYPE "ThreadContextType" AS ENUM ('REQUEST', 'OFFER', 'PROFESSIONAL', 'BOOKING', 'CONNECT_PROFILE', 'ITEM', 'ORDER', 'SUPPORT', 'BRIEF', 'MANAGED_REQUEST', 'DISPUTE');

-- CreateEnum
CREATE TYPE "ParticipantRole" AS ENUM ('MEMBER', 'STAFF');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "SystemMessageType" AS ENUM ('SUPPORT_OPENED', 'BOOKING_CREATED', 'BOOKING_STATE_CHANGED', 'ENQUIRY_CREATED', 'ENQUIRY_STATE_CHANGED', 'DISPUTE_OPENED', 'CONNECTION_ACCEPTED', 'PARTICIPANT_LEFT', 'ACCOUNT_DELETED', 'BRIEF_ATTACHED');

-- CreateEnum
CREATE TYPE "ActivityVerb" AS ENUM ('VIEW', 'SEARCH', 'CREATE', 'RESPOND', 'REACT', 'BOOKMARK', 'JOIN', 'ENQUIRE', 'BOOK', 'MESSAGE', 'DISMISS');

-- CreateEnum
CREATE TYPE "ActivitySubject" AS ENUM ('REQUEST', 'OFFER', 'UPDATE', 'GUIDE', 'GROUP', 'PROFESSIONAL_LISTING', 'CONNECT_PROFILE', 'STORE', 'STORE_ITEM', 'SEARCH_TERM');

-- CreateEnum
CREATE TYPE "SuggestionSurface" AS ENUM ('COMMUNITY_OFFER', 'COMMUNITY_REQUEST', 'PROFESSIONAL_SERVICE', 'STORE_ITEM');

-- AlterTable
ALTER TABLE "cities" ADD COLUMN     "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION,
ADD COLUMN     "region" TEXT,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Europe/London',
ADD COLUMN     "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "user_profile" ADD COLUMN     "date_of_birth" DATE,
ADD COLUMN     "date_of_birth_set_at" TIMESTAMPTZ,
ADD COLUMN     "heritage_tag" TEXT,
ADD COLUMN     "interests" JSONB,
ADD COLUMN     "journey_stage" TEXT,
ADD COLUMN     "languages" JSONB;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "anonymised_at" TIMESTAMPTZ,
ADD COLUMN     "deleted_email_hash" TEXT,
ADD COLUMN     "is_anonymised" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "stores" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type_code" TEXT NOT NULL DEFAULT 'LOCAL',
    "description" TEXT,
    "area" TEXT NOT NULL,
    "city_id" TEXT NOT NULL,
    "hides_exact_address" BOOLEAN NOT NULL DEFAULT false,
    "address_line1" TEXT,
    "postcode" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "logo_url" TEXT,
    "cover_url" TEXT,
    "status" "StoreStatus" NOT NULL DEFAULT 'OPEN',
    "compliance_state" "StoreComplianceState" NOT NULL DEFAULT 'ACTIVE',
    "delivers" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/London',
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "enquiry_count" INTEGER NOT NULL DEFAULT 0,
    "report_token" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_heritage_tags" (
    "store_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,

    CONSTRAINT "store_heritage_tags_pkey" PRIMARY KEY ("store_id","code")
);

-- CreateTable
CREATE TABLE "store_categories" (
    "store_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,

    CONSTRAINT "store_categories_pkey" PRIMARY KEY ("store_id","code")
);

-- CreateTable
CREATE TABLE "store_opening_hours" (
    "store_id" TEXT NOT NULL,
    "day" "Weekday" NOT NULL,
    "open_minutes" INTEGER,
    "close_minutes" INTEGER,

    CONSTRAINT "store_opening_hours_pkey" PRIMARY KEY ("store_id","day")
);

-- CreateTable
CREATE TABLE "store_contacts" (
    "store_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "store_contacts_pkey" PRIMARY KEY ("store_id","channel")
);

-- CreateTable
CREATE TABLE "store_items" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "unit_code" TEXT NOT NULL DEFAULT 'EACH',
    "unit_custom_label" TEXT,
    "category_code" TEXT NOT NULL,
    "options" TEXT,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "source_draft_id" TEXT,
    "report_token" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "store_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enquiries" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "buyer_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "state" "JobState" NOT NULL DEFAULT 'ACCEPTED',
    "fulfilment" "Fulfilment" NOT NULL,
    "delivery_address" TEXT,
    "note" TEXT,
    "estimated_total" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "conversation_id" TEXT,
    "ready_at" TIMESTAMPTZ,
    "received_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "cancelled_at" TIMESTAMPTZ,
    "cancel_reason" TEXT,
    "expires_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "enquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enquiry_lines" (
    "id" TEXT NOT NULL,
    "enquiry_id" TEXT NOT NULL,
    "item_id" TEXT,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" INTEGER NOT NULL,
    "unit_code" TEXT NOT NULL DEFAULT 'EACH',
    "currency" TEXT NOT NULL DEFAULT 'GBP',

    CONSTRAINT "enquiry_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enquiry_events" (
    "id" TEXT NOT NULL,
    "enquiry_id" TEXT NOT NULL,
    "stage" "JobStage" NOT NULL,
    "actor_id" TEXT,
    "note" TEXT,
    "reached_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enquiry_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_item_drafts" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "store_id" TEXT,
    "source_media_id" TEXT,
    "name" TEXT,
    "description" TEXT,
    "category_code" TEXT,
    "unit_code" TEXT,
    "suggested_price" INTEGER,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "accepted_item_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ,

    CONSTRAINT "ai_item_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_draft_jobs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "store_id" TEXT,
    "tone" TEXT NOT NULL DEFAULT 'WARM',
    "status" "QueueJobStatus",
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "ai_draft_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_requests" (
    "id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "category_code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "city_id" TEXT NOT NULL,
    "needed_on" DATE,
    "thank_you_amount" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "visibility" "PostVisibility" NOT NULL DEFAULT 'PUBLIC',
    "status" "RequestStatus" NOT NULL DEFAULT 'OPEN',
    "outcome" "RequestOutcome",
    "report_token" TEXT NOT NULL,
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "helper_count" INTEGER NOT NULL DEFAULT 0,
    "reply_count" INTEGER NOT NULL DEFAULT 0,
    "resolved_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "community_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_responses" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "is_help_offer" BOOLEAN NOT NULL DEFAULT false,
    "is_private" BOOLEAN NOT NULL DEFAULT false,
    "available_on" DATE,
    "thank_you_expected" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "request_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_helpers" (
    "request_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_helpers_pkey" PRIMARY KEY ("request_id","user_id")
);

-- CreateTable
CREATE TABLE "community_offers" (
    "id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category_code" TEXT NOT NULL,
    "city_id" TEXT NOT NULL,
    "delivery_mode" "DeliveryMode" NOT NULL DEFAULT 'IN_PERSON',
    "price_from" INTEGER,
    "price_basis" "PriceBasis" NOT NULL DEFAULT 'NEGOTIABLE',
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "visibility" "PostVisibility" NOT NULL DEFAULT 'PUBLIC',
    "report_token" TEXT NOT NULL,
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "promoted_to_listing_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "community_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_updates" (
    "id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "city_id" TEXT,
    "place_id" TEXT,
    "place_label" TEXT,
    "visibility" "PostVisibility" NOT NULL DEFAULT 'PUBLIC',
    "comments_enabled" BOOLEAN NOT NULL DEFAULT true,
    "reaction_count_hidden" BOOLEAN NOT NULL DEFAULT false,
    "report_token" TEXT NOT NULL,
    "reaction_count" INTEGER NOT NULL DEFAULT 0,
    "reply_count" INTEGER NOT NULL DEFAULT 0,
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "community_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "update_replies" (
    "id" TEXT NOT NULL,
    "update_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "update_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "update_reactions" (
    "update_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "update_reactions_pkey" PRIMARY KEY ("update_id","user_id")
);

-- CreateTable
CREATE TABLE "update_tags" (
    "update_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "update_tags_pkey" PRIMARY KEY ("update_id","user_id")
);

-- CreateTable
CREATE TABLE "guides" (
    "id" TEXT NOT NULL,
    "author_id" TEXT,
    "topic_code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "intro" TEXT NOT NULL,
    "blocks" JSONB NOT NULL,
    "resource_url" TEXT,
    "city_id" TEXT,
    "read_time_minutes" INTEGER NOT NULL DEFAULT 1,
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "like_count" INTEGER NOT NULL DEFAULT 0,
    "is_auto_generated" BOOLEAN NOT NULL DEFAULT false,
    "provenance_summary" TEXT,
    "reviewed_at" TIMESTAMPTZ,
    "reviewed_by_id" TEXT,
    "published_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "guides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guide_sources" (
    "id" TEXT NOT NULL,
    "guide_id" TEXT NOT NULL,
    "type" "GuideSourceType" NOT NULL,
    "ref_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "request_response_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guide_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guide_reactions" (
    "guide_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guide_reactions_pkey" PRIMARY KEY ("guide_id","user_id")
);

-- CreateTable
CREATE TABLE "guide_bookmarks" (
    "guide_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guide_bookmarks_pkey" PRIMARY KEY ("guide_id","user_id")
);

-- CreateTable
CREATE TABLE "guide_feedback" (
    "guide_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "useful" BOOLEAN NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "guide_feedback_pkey" PRIMARY KEY ("guide_id","user_id")
);

-- CreateTable
CREATE TABLE "guide_progress" (
    "guide_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "guide_progress_pkey" PRIMARY KEY ("guide_id","user_id")
);

-- CreateTable
CREATE TABLE "guide_deflections" (
    "id" TEXT NOT NULL,
    "guide_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "outcome" "DeflectionOutcome" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guide_deflections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "rules" TEXT,
    "city_id" TEXT NOT NULL,
    "join_policy" "JoinPolicy" NOT NULL DEFAULT 'OPEN',
    "avatar_url" TEXT,
    "created_by_id" TEXT NOT NULL,
    "member_count" INTEGER NOT NULL DEFAULT 0,
    "post_count" INTEGER NOT NULL DEFAULT 0,
    "last_post_at" TIMESTAMPTZ,
    "report_token" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_memberships" (
    "group_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "state" "GroupMembershipState" NOT NULL DEFAULT 'MEMBER',
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "last_read_at" TIMESTAMPTZ,
    "last_active_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joined_at" TIMESTAMPTZ,
    "decided_at" TIMESTAMPTZ,

    CONSTRAINT "group_memberships_pkey" PRIMARY KEY ("group_id","user_id")
);

-- CreateTable
CREATE TABLE "group_posts" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "reply_count" INTEGER NOT NULL DEFAULT 0,
    "report_token" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "group_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_post_replies" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "group_post_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connect_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type_code" TEXT NOT NULL,
    "looking_for" TEXT NOT NULL,
    "dm_policy" "DmPolicy" NOT NULL DEFAULT 'REQUEST_FIRST',
    "is_visible" BOOLEAN NOT NULL DEFAULT false,
    "city_id_override" TEXT,
    "dating_confirmed_at" TIMESTAMPTZ,
    "report_token" TEXT NOT NULL,
    "last_active_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "connect_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connection_requests" (
    "id" TEXT NOT NULL,
    "from_profile_id" TEXT NOT NULL,
    "to_profile_id" TEXT NOT NULL,
    "from_user_id" TEXT NOT NULL,
    "to_user_id" TEXT NOT NULL,
    "note" TEXT,
    "state" "ConnectionRequestState" NOT NULL DEFAULT 'PENDING',
    "conversation_id" TEXT,
    "responded_at" TIMESTAMPTZ,
    "cooldown_until" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "connection_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "verb" "ActivityVerb" NOT NULL,
    "subject" "ActivitySubject" NOT NULL,
    "subject_id" TEXT,
    "city_id" TEXT,
    "code" TEXT,
    "term" TEXT,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "metadata" JSONB,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feed_feedback" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "item_type" "FeedItemType" NOT NULL,
    "item_id" TEXT NOT NULL,
    "reason" "FeedFeedbackReason",
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feed_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demand_signals" (
    "id" TEXT NOT NULL,
    "city_id" TEXT,
    "surface" "SuggestionSurface" NOT NULL,
    "code" TEXT,
    "term" TEXT,
    "label" TEXT NOT NULL,
    "search_count" INTEGER NOT NULL DEFAULT 0,
    "action_count" INTEGER NOT NULL DEFAULT 0,
    "supply_count" INTEGER NOT NULL DEFAULT 0,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "window_start" TIMESTAMPTZ NOT NULL,
    "window_end" TIMESTAMPTZ NOT NULL,
    "computed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demand_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_clusters" (
    "id" TEXT NOT NULL,
    "category_code" TEXT NOT NULL,
    "city_id" TEXT,
    "signature" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "request_ids" JSONB NOT NULL,
    "ask_count" INTEGER NOT NULL DEFAULT 0,
    "drafted_guide_id" TEXT,
    "first_asked_at" TIMESTAMPTZ NOT NULL,
    "last_asked_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "question_clusters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_snapshots" (
    "id" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "city_id" TEXT,
    "period" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "window_start" TIMESTAMPTZ NOT NULL,
    "window_end" TIMESTAMPTZ NOT NULL,
    "computed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media" (
    "id" TEXT NOT NULL,
    "uploaded_by_id" TEXT NOT NULL,
    "type" "MediaType" NOT NULL,
    "status" "MediaStatus" NOT NULL DEFAULT 'PENDING',
    "mime_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "url" TEXT,
    "thumbnail_url" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "blur_hash" TEXT,
    "duration_ms" INTEGER,
    "waveform" JSONB,
    "owner_type" TEXT,
    "owner_id" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ,
    "attached_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "kind" "ThreadKind" NOT NULL,
    "context_type" "ThreadContextType",
    "context_id" TEXT,
    "context_snapshot" JSONB,
    "participant_key" TEXT NOT NULL,
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "last_message_at" TIMESTAMPTZ,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_participants" (
    "conversation_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "ParticipantRole" NOT NULL DEFAULT 'MEMBER',
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "last_read_message_id" TEXT,
    "last_read_at" TIMESTAMPTZ,
    "muted_until" TIMESTAMPTZ,
    "is_muted" BOOLEAN NOT NULL DEFAULT false,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "has_sent_message" BOOLEAN NOT NULL DEFAULT false,
    "joined_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ,

    CONSTRAINT "conversation_participants_pkey" PRIMARY KEY ("conversation_id","user_id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "sender_id" TEXT,
    "kind" "MessageKind" NOT NULL DEFAULT 'TEXT',
    "body" TEXT,
    "system_type" "SystemMessageType",
    "system_data" JSONB,
    "client_id" TEXT NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'SENT',
    "sent_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMPTZ,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_attachments" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_receipts" (
    "message_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "delivered_at" TIMESTAMPTZ,
    "read_at" TIMESTAMPTZ,

    CONSTRAINT "message_receipts_pkey" PRIMARY KEY ("message_id","user_id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "reporter_id" TEXT NOT NULL,
    "target_type" "ReportTargetType" NOT NULL,
    "target_id" TEXT NOT NULL,
    "target_user_id" TEXT,
    "reason_code" "ReportReason" NOT NULL,
    "note" TEXT,
    "state" "ReportState" NOT NULL DEFAULT 'RECEIVED',
    "snapshot" JSONB,
    "risk_level" "RiskLevel" NOT NULL DEFAULT 'NONE',
    "risk_category" "RiskCategory",
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMPTZ,
    "decision" "ModerationDecision",
    "decision_note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocks" (
    "blocker_id" TEXT NOT NULL,
    "blocked_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocks_pkey" PRIMARY KEY ("blocker_id","blocked_id")
);

-- CreateTable
CREATE TABLE "moderation_queue_items" (
    "id" TEXT NOT NULL,
    "type" "ModerationQueueType" NOT NULL,
    "state" "ModerationQueueState" NOT NULL DEFAULT 'PENDING',
    "target_type" "ReportTargetType" NOT NULL,
    "target_id" TEXT NOT NULL,
    "subject_user_id" TEXT,
    "report_id" TEXT,
    "risk_level" "RiskLevel" NOT NULL DEFAULT 'NONE',
    "risk_category" "RiskCategory",
    "risk_score" INTEGER NOT NULL DEFAULT 0,
    "risk_signals" JSONB,
    "summary" TEXT,
    "payload" JSONB,
    "assigned_to_id" TEXT,
    "decision" "ModerationDecision",
    "decision_note" TEXT,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "moderation_queue_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_actions" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "target_type" "ReportTargetType" NOT NULL,
    "target_id" TEXT NOT NULL,
    "decision" "ModerationDecision" NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guard_threads" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "category_code" TEXT,
    "state" "GuardThreadState" NOT NULL DEFAULT 'OPEN',
    "risk_level" "RiskLevel" NOT NULL DEFAULT 'NONE',
    "risk_category" "RiskCategory",
    "risk_score" INTEGER NOT NULL DEFAULT 0,
    "risk_signals" JSONB,
    "conversation_id" TEXT,
    "assigned_to_id" TEXT,
    "resolved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "guard_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_terms" (
    "id" TEXT NOT NULL,
    "category" "RiskCategory" NOT NULL,
    "pattern" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 10,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "risk_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "professional_listings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "profession_title" TEXT NOT NULL,
    "experience_level" "ExperienceLevel" NOT NULL,
    "years_experience" INTEGER,
    "about" TEXT NOT NULL,
    "city_id" TEXT NOT NULL,
    "delivery_mode" "DeliveryMode" NOT NULL DEFAULT 'IN_PERSON',
    "price_from" INTEGER,
    "price_basis" "PriceBasis" NOT NULL DEFAULT 'NEGOTIABLE',
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "is_accepting_work" BOOLEAN NOT NULL DEFAULT true,
    "free_consultation" BOOLEAN NOT NULL DEFAULT false,
    "verification_status" "ListingVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "consent_accepted" BOOLEAN NOT NULL DEFAULT false,
    "consent_accepted_at" TIMESTAMPTZ,
    "consent_version" TEXT,
    "source_offer_id" TEXT,
    "profile_views" INTEGER NOT NULL DEFAULT 0,
    "jobs_completed" INTEGER NOT NULL DEFAULT 0,
    "median_response_minutes" INTEGER,
    "submitted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "professional_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "professional_listing_categories" (
    "listing_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "professional_listing_categories_pkey" PRIMARY KEY ("listing_id","code")
);

-- CreateTable
CREATE TABLE "professional_services" (
    "id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" INTEGER,
    "price_basis" "PriceBasis" NOT NULL DEFAULT 'NEGOTIABLE',
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "professional_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "managed_briefs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "category_code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "urgency" "BriefUrgency" NOT NULL DEFAULT 'FLEXIBLE',
    "budget" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "city_id" TEXT,
    "state" "BriefState" NOT NULL DEFAULT 'OPEN',
    "chosen_listing_id" TEXT,
    "booking_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "managed_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brief_matches" (
    "id" TEXT NOT NULL,
    "brief_id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "total_score" DOUBLE PRECISION NOT NULL,
    "rating_score" DOUBLE PRECISION NOT NULL,
    "distance_score" DOUBLE PRECISION NOT NULL,
    "price_score" DOUBLE PRECISION NOT NULL,
    "response_score" DOUBLE PRECISION NOT NULL,
    "price_for_brief" INTEGER,
    "rationale" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brief_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "professional_id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "service_id" TEXT,
    "brief_id" TEXT,
    "service_name" TEXT NOT NULL,
    "service_description" TEXT,
    "quoted_amount" INTEGER,
    "agreed_amount" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "state" "JobState" NOT NULL DEFAULT 'PENDING_ACCEPTANCE',
    "preferred_date" DATE,
    "preferred_time_slot" TEXT,
    "is_flexible" BOOLEAN NOT NULL DEFAULT false,
    "mode" "BookingMode" NOT NULL DEFAULT 'ONLINE',
    "address" TEXT,
    "details" TEXT,
    "conversation_id" TEXT,
    "delivered_at" TIMESTAMPTZ,
    "auto_complete_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "cancelled_at" TIMESTAMPTZ,
    "cancel_reason" TEXT,
    "first_client_message_at" TIMESTAMPTZ,
    "first_pro_reply_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_events" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "stage" "JobStage" NOT NULL,
    "actor_id" TEXT,
    "note" TEXT,
    "metadata" JSONB,
    "reached_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disputes" (
    "id" TEXT NOT NULL,
    "subject_type" "DisputeSubjectType" NOT NULL,
    "booking_id" TEXT,
    "enquiry_id" TEXT,
    "raised_by_id" TEXT NOT NULL,
    "reason_code" "DisputeReason" NOT NULL,
    "description" TEXT NOT NULL,
    "state" "DisputeState" NOT NULL DEFAULT 'OPEN',
    "conversation_id" TEXT,
    "expected_resolution_at" TIMESTAMPTZ,
    "resolved_at" TIMESTAMPTZ,
    "resolution_note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_evidence" (
    "id" TEXT NOT NULL,
    "dispute_id" TEXT NOT NULL,
    "submitted_by_id" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispute_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "managed_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "subject_type" "ManagedRequestSubject" NOT NULL,
    "state" "ManagedRequestState" NOT NULL DEFAULT 'OPEN',
    "help_areas" JSONB,
    "notes" TEXT,
    "store_id" TEXT,
    "brief_id" TEXT,
    "conversation_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "managed_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taxonomy_terms" (
    "id" TEXT NOT NULL,
    "kind" "TaxonomyKind" NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "taxonomy_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taxonomy_version" (
    "id" TEXT NOT NULL DEFAULT 'SINGLETON',
    "version" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "taxonomy_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trust_checks" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "check" "TrustCheckType" NOT NULL,
    "status" "TrustCheckStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "category_code" TEXT,
    "document_type" TEXT,
    "issuing_body" TEXT,
    "reference" TEXT,
    "checked_by" TEXT,
    "rejection_reason" TEXT,
    "rejected_fields" JSONB,
    "submitted_at" TIMESTAMPTZ,
    "verified_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "trust_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "subject_user_id" TEXT NOT NULL,
    "reviewer_id" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT NOT NULL,
    "context" "ReviewContext" NOT NULL,
    "source_id" TEXT,
    "counts_to_average" BOOLEAN NOT NULL DEFAULT true,
    "tags" JSONB,
    "reviewer_country_of_origin" TEXT,
    "request_id" TEXT,
    "booking_id" TEXT,
    "enquiry_id" TEXT,
    "editable_until" TIMESTAMPTZ,
    "reply" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reputation_summaries" (
    "user_id" TEXT NOT NULL,
    "average" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "counted_total" INTEGER NOT NULL DEFAULT 0,
    "excluded_total" INTEGER NOT NULL DEFAULT 0,
    "star_5" INTEGER NOT NULL DEFAULT 0,
    "star_4" INTEGER NOT NULL DEFAULT 0,
    "star_3" INTEGER NOT NULL DEFAULT 0,
    "star_2" INTEGER NOT NULL DEFAULT 0,
    "star_1" INTEGER NOT NULL DEFAULT 0,
    "community_count" INTEGER NOT NULL DEFAULT 0,
    "booking_count" INTEGER NOT NULL DEFAULT 0,
    "order_count" INTEGER NOT NULL DEFAULT 0,
    "prior_work_count" INTEGER NOT NULL DEFAULT 0,
    "immigrant_review_count" INTEGER NOT NULL DEFAULT 0,
    "immigrant_review_average" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "is_immigrant_friendly" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "reputation_summaries_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stores_owner_id_key" ON "stores"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "stores_report_token_key" ON "stores"("report_token");

-- CreateIndex
CREATE INDEX "stores_city_id_status_idx" ON "stores"("city_id", "status");

-- CreateIndex
CREATE INDEX "stores_type_code_idx" ON "stores"("type_code");

-- CreateIndex
CREATE INDEX "store_heritage_tags_code_idx" ON "store_heritage_tags"("code");

-- CreateIndex
CREATE INDEX "store_categories_code_idx" ON "store_categories"("code");

-- CreateIndex
CREATE UNIQUE INDEX "store_items_report_token_key" ON "store_items"("report_token");

-- CreateIndex
CREATE INDEX "store_items_store_id_is_available_idx" ON "store_items"("store_id", "is_available");

-- CreateIndex
CREATE INDEX "store_items_category_code_price_idx" ON "store_items"("category_code", "price");

-- CreateIndex
CREATE UNIQUE INDEX "enquiries_reference_key" ON "enquiries"("reference");

-- CreateIndex
CREATE INDEX "enquiries_buyer_id_state_created_at_idx" ON "enquiries"("buyer_id", "state", "created_at");

-- CreateIndex
CREATE INDEX "enquiries_seller_id_state_created_at_idx" ON "enquiries"("seller_id", "state", "created_at");

-- CreateIndex
CREATE INDEX "enquiries_state_expires_at_idx" ON "enquiries"("state", "expires_at");

-- CreateIndex
CREATE INDEX "enquiry_lines_enquiry_id_idx" ON "enquiry_lines"("enquiry_id");

-- CreateIndex
CREATE INDEX "enquiry_events_enquiry_id_reached_at_idx" ON "enquiry_events"("enquiry_id", "reached_at");

-- CreateIndex
CREATE UNIQUE INDEX "enquiry_events_enquiry_id_stage_key" ON "enquiry_events"("enquiry_id", "stage");

-- CreateIndex
CREATE INDEX "ai_item_drafts_job_id_idx" ON "ai_item_drafts"("job_id");

-- CreateIndex
CREATE INDEX "ai_item_drafts_user_id_created_at_idx" ON "ai_item_drafts"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_draft_jobs_user_id_created_at_idx" ON "ai_draft_jobs"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "community_requests_report_token_key" ON "community_requests"("report_token");

-- CreateIndex
CREATE INDEX "community_requests_city_id_status_created_at_idx" ON "community_requests"("city_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "community_requests_category_code_status_idx" ON "community_requests"("category_code", "status");

-- CreateIndex
CREATE INDEX "community_requests_author_id_created_at_idx" ON "community_requests"("author_id", "created_at");

-- CreateIndex
CREATE INDEX "community_requests_status_created_at_idx" ON "community_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "request_responses_request_id_created_at_idx" ON "request_responses"("request_id", "created_at");

-- CreateIndex
CREATE INDEX "request_responses_author_id_idx" ON "request_responses"("author_id");

-- CreateIndex
CREATE UNIQUE INDEX "request_responses_request_id_author_id_is_help_offer_key" ON "request_responses"("request_id", "author_id", "is_help_offer");

-- CreateIndex
CREATE INDEX "request_helpers_user_id_idx" ON "request_helpers"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "community_offers_report_token_key" ON "community_offers"("report_token");

-- CreateIndex
CREATE UNIQUE INDEX "community_offers_promoted_to_listing_id_key" ON "community_offers"("promoted_to_listing_id");

-- CreateIndex
CREATE INDEX "community_offers_city_id_created_at_idx" ON "community_offers"("city_id", "created_at");

-- CreateIndex
CREATE INDEX "community_offers_category_code_idx" ON "community_offers"("category_code");

-- CreateIndex
CREATE INDEX "community_offers_author_id_created_at_idx" ON "community_offers"("author_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "community_updates_report_token_key" ON "community_updates"("report_token");

-- CreateIndex
CREATE INDEX "community_updates_city_id_created_at_idx" ON "community_updates"("city_id", "created_at");

-- CreateIndex
CREATE INDEX "community_updates_author_id_created_at_idx" ON "community_updates"("author_id", "created_at");

-- CreateIndex
CREATE INDEX "update_replies_update_id_created_at_idx" ON "update_replies"("update_id", "created_at");

-- CreateIndex
CREATE INDEX "update_reactions_user_id_idx" ON "update_reactions"("user_id");

-- CreateIndex
CREATE INDEX "update_tags_user_id_idx" ON "update_tags"("user_id");

-- CreateIndex
CREATE INDEX "guides_topic_code_published_at_idx" ON "guides"("topic_code", "published_at");

-- CreateIndex
CREATE INDEX "guides_city_id_published_at_idx" ON "guides"("city_id", "published_at");

-- CreateIndex
CREATE INDEX "guides_published_at_idx" ON "guides"("published_at");

-- CreateIndex
CREATE INDEX "guide_sources_guide_id_idx" ON "guide_sources"("guide_id");

-- CreateIndex
CREATE INDEX "guide_reactions_user_id_idx" ON "guide_reactions"("user_id");

-- CreateIndex
CREATE INDEX "guide_bookmarks_user_id_created_at_idx" ON "guide_bookmarks"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "guide_feedback_guide_id_useful_idx" ON "guide_feedback"("guide_id", "useful");

-- CreateIndex
CREATE INDEX "guide_progress_user_id_updated_at_idx" ON "guide_progress"("user_id", "updated_at");

-- CreateIndex
CREATE INDEX "guide_deflections_guide_id_outcome_idx" ON "guide_deflections"("guide_id", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "groups_report_token_key" ON "groups"("report_token");

-- CreateIndex
CREATE INDEX "groups_city_id_member_count_idx" ON "groups"("city_id", "member_count");

-- CreateIndex
CREATE INDEX "groups_created_at_idx" ON "groups"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "groups_city_id_name_key" ON "groups"("city_id", "name");

-- CreateIndex
CREATE INDEX "group_memberships_user_id_state_idx" ON "group_memberships"("user_id", "state");

-- CreateIndex
CREATE INDEX "group_memberships_group_id_state_idx" ON "group_memberships"("group_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "group_posts_report_token_key" ON "group_posts"("report_token");

-- CreateIndex
CREATE INDEX "group_posts_group_id_created_at_idx" ON "group_posts"("group_id", "created_at");

-- CreateIndex
CREATE INDEX "group_posts_author_id_idx" ON "group_posts"("author_id");

-- CreateIndex
CREATE INDEX "group_post_replies_post_id_created_at_idx" ON "group_post_replies"("post_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "connect_profiles_user_id_key" ON "connect_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "connect_profiles_report_token_key" ON "connect_profiles"("report_token");

-- CreateIndex
CREATE INDEX "connect_profiles_is_visible_type_code_idx" ON "connect_profiles"("is_visible", "type_code");

-- CreateIndex
CREATE INDEX "connect_profiles_is_visible_last_active_at_idx" ON "connect_profiles"("is_visible", "last_active_at");

-- CreateIndex
CREATE INDEX "connection_requests_to_profile_id_state_created_at_idx" ON "connection_requests"("to_profile_id", "state", "created_at");

-- CreateIndex
CREATE INDEX "connection_requests_from_profile_id_state_created_at_idx" ON "connection_requests"("from_profile_id", "state", "created_at");

-- CreateIndex
CREATE INDEX "connection_requests_from_user_id_to_user_id_idx" ON "connection_requests"("from_user_id", "to_user_id");

-- CreateIndex
CREATE INDEX "activity_events_city_id_subject_occurred_at_idx" ON "activity_events"("city_id", "subject", "occurred_at");

-- CreateIndex
CREATE INDEX "activity_events_user_id_occurred_at_idx" ON "activity_events"("user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "activity_events_subject_code_occurred_at_idx" ON "activity_events"("subject", "code", "occurred_at");

-- CreateIndex
CREATE INDEX "activity_events_verb_term_occurred_at_idx" ON "activity_events"("verb", "term", "occurred_at");

-- CreateIndex
CREATE INDEX "feed_feedback_user_id_created_at_idx" ON "feed_feedback"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "feed_feedback_user_id_item_type_item_id_key" ON "feed_feedback"("user_id", "item_type", "item_id");

-- CreateIndex
CREATE INDEX "demand_signals_city_id_surface_score_idx" ON "demand_signals"("city_id", "surface", "score");

-- CreateIndex
CREATE UNIQUE INDEX "demand_signals_city_id_surface_code_term_key" ON "demand_signals"("city_id", "surface", "code", "term");

-- CreateIndex
CREATE INDEX "question_clusters_ask_count_last_asked_at_idx" ON "question_clusters"("ask_count", "last_asked_at");

-- CreateIndex
CREATE UNIQUE INDEX "question_clusters_category_code_city_id_signature_key" ON "question_clusters"("category_code", "city_id", "signature");

-- CreateIndex
CREATE INDEX "metric_snapshots_section_city_id_idx" ON "metric_snapshots"("section", "city_id");

-- CreateIndex
CREATE UNIQUE INDEX "metric_snapshots_section_metric_city_id_period_key" ON "metric_snapshots"("section", "metric", "city_id", "period");

-- CreateIndex
CREATE UNIQUE INDEX "media_storage_key_key" ON "media"("storage_key");

-- CreateIndex
CREATE INDEX "media_uploaded_by_id_idx" ON "media"("uploaded_by_id");

-- CreateIndex
CREATE INDEX "media_owner_type_owner_id_position_idx" ON "media"("owner_type", "owner_id", "position");

-- CreateIndex
CREATE INDEX "media_status_created_at_idx" ON "media"("status", "created_at");

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_user_id_key_endpoint_key" ON "idempotency_records"("user_id", "key", "endpoint");

-- CreateIndex
CREATE INDEX "conversations_kind_last_message_at_idx" ON "conversations"("kind", "last_message_at");

-- CreateIndex
CREATE INDEX "conversations_last_message_at_idx" ON "conversations"("last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_participant_key_context_type_context_id_key" ON "conversations"("participant_key", "context_type", "context_id");

-- CreateIndex
CREATE INDEX "conversation_participants_user_id_is_archived_idx" ON "conversation_participants"("user_id", "is_archived");

-- CreateIndex
CREATE INDEX "conversation_participants_user_id_unread_count_idx" ON "conversation_participants"("user_id", "unread_count");

-- CreateIndex
CREATE INDEX "messages_conversation_id_sent_at_idx" ON "messages"("conversation_id", "sent_at");

-- CreateIndex
CREATE INDEX "messages_sender_id_idx" ON "messages"("sender_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_client_id_key" ON "messages"("conversation_id", "client_id");

-- CreateIndex
CREATE INDEX "message_attachments_message_id_idx" ON "message_attachments"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_attachments_message_id_media_id_key" ON "message_attachments"("message_id", "media_id");

-- CreateIndex
CREATE INDEX "message_receipts_user_id_idx" ON "message_receipts"("user_id");

-- CreateIndex
CREATE INDEX "reports_state_risk_level_created_at_idx" ON "reports"("state", "risk_level", "created_at");

-- CreateIndex
CREATE INDEX "reports_target_type_target_id_idx" ON "reports"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "reports_reporter_id_idx" ON "reports"("reporter_id");

-- CreateIndex
CREATE INDEX "blocks_blocked_id_idx" ON "blocks"("blocked_id");

-- CreateIndex
CREATE INDEX "moderation_queue_items_state_risk_score_created_at_idx" ON "moderation_queue_items"("state", "risk_score", "created_at");

-- CreateIndex
CREATE INDEX "moderation_queue_items_type_state_idx" ON "moderation_queue_items"("type", "state");

-- CreateIndex
CREATE UNIQUE INDEX "moderation_queue_items_type_target_type_target_id_key" ON "moderation_queue_items"("type", "target_type", "target_id");

-- CreateIndex
CREATE INDEX "moderation_actions_target_type_target_id_idx" ON "moderation_actions"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "moderation_actions_actor_id_created_at_idx" ON "moderation_actions"("actor_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "guard_threads_conversation_id_key" ON "guard_threads"("conversation_id");

-- CreateIndex
CREATE INDEX "guard_threads_state_risk_score_created_at_idx" ON "guard_threads"("state", "risk_score", "created_at");

-- CreateIndex
CREATE INDEX "guard_threads_user_id_created_at_idx" ON "guard_threads"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "risk_terms_is_active_idx" ON "risk_terms"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "risk_terms_category_pattern_key" ON "risk_terms"("category", "pattern");

-- CreateIndex
CREATE UNIQUE INDEX "professional_listings_user_id_key" ON "professional_listings"("user_id");

-- CreateIndex
CREATE INDEX "professional_listings_city_id_is_accepting_work_idx" ON "professional_listings"("city_id", "is_accepting_work");

-- CreateIndex
CREATE INDEX "professional_listings_verification_status_idx" ON "professional_listings"("verification_status");

-- CreateIndex
CREATE INDEX "professional_listing_categories_code_idx" ON "professional_listing_categories"("code");

-- CreateIndex
CREATE INDEX "professional_services_listing_id_is_active_idx" ON "professional_services"("listing_id", "is_active");

-- CreateIndex
CREATE INDEX "managed_briefs_user_id_state_idx" ON "managed_briefs"("user_id", "state");

-- CreateIndex
CREATE INDEX "brief_matches_brief_id_rank_idx" ON "brief_matches"("brief_id", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "brief_matches_brief_id_listing_id_key" ON "brief_matches"("brief_id", "listing_id");

-- CreateIndex
CREATE INDEX "bookings_client_id_state_created_at_idx" ON "bookings"("client_id", "state", "created_at");

-- CreateIndex
CREATE INDEX "bookings_professional_id_state_created_at_idx" ON "bookings"("professional_id", "state", "created_at");

-- CreateIndex
CREATE INDEX "bookings_state_auto_complete_at_idx" ON "bookings"("state", "auto_complete_at");

-- CreateIndex
CREATE INDEX "booking_events_booking_id_reached_at_idx" ON "booking_events"("booking_id", "reached_at");

-- CreateIndex
CREATE UNIQUE INDEX "booking_events_booking_id_stage_key" ON "booking_events"("booking_id", "stage");

-- CreateIndex
CREATE INDEX "disputes_state_created_at_idx" ON "disputes"("state", "created_at");

-- CreateIndex
CREATE INDEX "disputes_booking_id_idx" ON "disputes"("booking_id");

-- CreateIndex
CREATE INDEX "disputes_enquiry_id_idx" ON "disputes"("enquiry_id");

-- CreateIndex
CREATE INDEX "dispute_evidence_dispute_id_idx" ON "dispute_evidence"("dispute_id");

-- CreateIndex
CREATE INDEX "managed_requests_state_created_at_idx" ON "managed_requests"("state", "created_at");

-- CreateIndex
CREATE INDEX "managed_requests_user_id_idx" ON "managed_requests"("user_id");

-- CreateIndex
CREATE INDEX "taxonomy_terms_kind_is_active_sort_idx" ON "taxonomy_terms"("kind", "is_active", "sort");

-- CreateIndex
CREATE UNIQUE INDEX "taxonomy_terms_kind_code_key" ON "taxonomy_terms"("kind", "code");

-- CreateIndex
CREATE INDEX "trust_checks_user_id_status_idx" ON "trust_checks"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "trust_checks_user_id_check_category_code_key" ON "trust_checks"("user_id", "check", "category_code");

-- CreateIndex
CREATE INDEX "reviews_subject_user_id_counts_to_average_created_at_idx" ON "reviews"("subject_user_id", "counts_to_average", "created_at");

-- CreateIndex
CREATE INDEX "reviews_subject_user_id_context_idx" ON "reviews"("subject_user_id", "context");

-- CreateIndex
CREATE INDEX "reviews_reviewer_id_idx" ON "reviews"("reviewer_id");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_reviewer_id_context_source_id_key" ON "reviews"("reviewer_id", "context", "source_id");

-- CreateIndex
CREATE INDEX "reputation_summaries_average_counted_total_idx" ON "reputation_summaries"("average", "counted_total");

-- CreateIndex
CREATE INDEX "reputation_summaries_is_immigrant_friendly_idx" ON "reputation_summaries"("is_immigrant_friendly");

-- CreateIndex
CREATE INDEX "cities_name_idx" ON "cities"("name");

-- CreateIndex
CREATE UNIQUE INDEX "users_deleted_email_hash_key" ON "users"("deleted_email_hash");

-- AddForeignKey
ALTER TABLE "stores" ADD CONSTRAINT "stores_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stores" ADD CONSTRAINT "stores_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_heritage_tags" ADD CONSTRAINT "store_heritage_tags_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_categories" ADD CONSTRAINT "store_categories_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_opening_hours" ADD CONSTRAINT "store_opening_hours_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_contacts" ADD CONSTRAINT "store_contacts_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_items" ADD CONSTRAINT "store_items_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiry_lines" ADD CONSTRAINT "enquiry_lines_enquiry_id_fkey" FOREIGN KEY ("enquiry_id") REFERENCES "enquiries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiry_lines" ADD CONSTRAINT "enquiry_lines_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "store_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiry_events" ADD CONSTRAINT "enquiry_events_enquiry_id_fkey" FOREIGN KEY ("enquiry_id") REFERENCES "enquiries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_item_drafts" ADD CONSTRAINT "ai_item_drafts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_item_drafts" ADD CONSTRAINT "ai_item_drafts_source_media_id_fkey" FOREIGN KEY ("source_media_id") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_draft_jobs" ADD CONSTRAINT "ai_draft_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_requests" ADD CONSTRAINT "community_requests_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_requests" ADD CONSTRAINT "community_requests_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_responses" ADD CONSTRAINT "request_responses_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "community_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_responses" ADD CONSTRAINT "request_responses_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_helpers" ADD CONSTRAINT "request_helpers_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "community_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_helpers" ADD CONSTRAINT "request_helpers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_offers" ADD CONSTRAINT "community_offers_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_offers" ADD CONSTRAINT "community_offers_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_offers" ADD CONSTRAINT "community_offers_promoted_to_listing_id_fkey" FOREIGN KEY ("promoted_to_listing_id") REFERENCES "professional_listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_updates" ADD CONSTRAINT "community_updates_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_updates" ADD CONSTRAINT "community_updates_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "update_replies" ADD CONSTRAINT "update_replies_update_id_fkey" FOREIGN KEY ("update_id") REFERENCES "community_updates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "update_replies" ADD CONSTRAINT "update_replies_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "update_reactions" ADD CONSTRAINT "update_reactions_update_id_fkey" FOREIGN KEY ("update_id") REFERENCES "community_updates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "update_reactions" ADD CONSTRAINT "update_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "update_tags" ADD CONSTRAINT "update_tags_update_id_fkey" FOREIGN KEY ("update_id") REFERENCES "community_updates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "update_tags" ADD CONSTRAINT "update_tags_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guides" ADD CONSTRAINT "guides_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guides" ADD CONSTRAINT "guides_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guide_sources" ADD CONSTRAINT "guide_sources_guide_id_fkey" FOREIGN KEY ("guide_id") REFERENCES "guides"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guide_sources" ADD CONSTRAINT "guide_sources_request_response_id_fkey" FOREIGN KEY ("request_response_id") REFERENCES "request_responses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guide_reactions" ADD CONSTRAINT "guide_reactions_guide_id_fkey" FOREIGN KEY ("guide_id") REFERENCES "guides"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guide_reactions" ADD CONSTRAINT "guide_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guide_bookmarks" ADD CONSTRAINT "guide_bookmarks_guide_id_fkey" FOREIGN KEY ("guide_id") REFERENCES "guides"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guide_bookmarks" ADD CONSTRAINT "guide_bookmarks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guide_feedback" ADD CONSTRAINT "guide_feedback_guide_id_fkey" FOREIGN KEY ("guide_id") REFERENCES "guides"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guide_feedback" ADD CONSTRAINT "guide_feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guide_progress" ADD CONSTRAINT "guide_progress_guide_id_fkey" FOREIGN KEY ("guide_id") REFERENCES "guides"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guide_progress" ADD CONSTRAINT "guide_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guide_deflections" ADD CONSTRAINT "guide_deflections_guide_id_fkey" FOREIGN KEY ("guide_id") REFERENCES "guides"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guide_deflections" ADD CONSTRAINT "guide_deflections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_posts" ADD CONSTRAINT "group_posts_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_posts" ADD CONSTRAINT "group_posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_post_replies" ADD CONSTRAINT "group_post_replies_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "group_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_post_replies" ADD CONSTRAINT "group_post_replies_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connect_profiles" ADD CONSTRAINT "connect_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connect_profiles" ADD CONSTRAINT "connect_profiles_city_id_override_fkey" FOREIGN KEY ("city_id_override") REFERENCES "cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_requests" ADD CONSTRAINT "connection_requests_from_profile_id_fkey" FOREIGN KEY ("from_profile_id") REFERENCES "connect_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_requests" ADD CONSTRAINT "connection_requests_to_profile_id_fkey" FOREIGN KEY ("to_profile_id") REFERENCES "connect_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_requests" ADD CONSTRAINT "connection_requests_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_feedback" ADD CONSTRAINT "feed_feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media" ADD CONSTRAINT "media_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_receipts" ADD CONSTRAINT "message_receipts_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_receipts" ADD CONSTRAINT "message_receipts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_queue_items" ADD CONSTRAINT "moderation_queue_items_subject_user_id_fkey" FOREIGN KEY ("subject_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_queue_items" ADD CONSTRAINT "moderation_queue_items_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guard_threads" ADD CONSTRAINT "guard_threads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guard_threads" ADD CONSTRAINT "guard_threads_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guard_threads" ADD CONSTRAINT "guard_threads_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_listings" ADD CONSTRAINT "professional_listings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_listings" ADD CONSTRAINT "professional_listings_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_listing_categories" ADD CONSTRAINT "professional_listing_categories_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "professional_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_services" ADD CONSTRAINT "professional_services_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "professional_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_briefs" ADD CONSTRAINT "managed_briefs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_briefs" ADD CONSTRAINT "managed_briefs_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brief_matches" ADD CONSTRAINT "brief_matches_brief_id_fkey" FOREIGN KEY ("brief_id") REFERENCES "managed_briefs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brief_matches" ADD CONSTRAINT "brief_matches_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "professional_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "professional_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "professional_services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_brief_id_fkey" FOREIGN KEY ("brief_id") REFERENCES "managed_briefs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_events" ADD CONSTRAINT "booking_events_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_enquiry_id_fkey" FOREIGN KEY ("enquiry_id") REFERENCES "enquiries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_raised_by_id_fkey" FOREIGN KEY ("raised_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_requests" ADD CONSTRAINT "managed_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_requests" ADD CONSTRAINT "managed_requests_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trust_checks" ADD CONSTRAINT "trust_checks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_subject_user_id_fkey" FOREIGN KEY ("subject_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "community_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_enquiry_id_fkey" FOREIGN KEY ("enquiry_id") REFERENCES "enquiries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reputation_summaries" ADD CONSTRAINT "reputation_summaries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Free-text search indexes ────────────────────────────────────────────────
-- Every `q` parameter in the spec searches a title and a body. Without these the
-- ILIKE falls back to a sequential scan, which is fine at 100 rows and not at
-- 100,000.
CREATE INDEX "community_requests_title_trgm_idx" ON "community_requests" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "community_offers_title_trgm_idx" ON "community_offers" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "guides_title_trgm_idx" ON "guides" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "guides_intro_trgm_idx" ON "guides" USING GIN ("intro" gin_trgm_ops);
CREATE INDEX "groups_name_trgm_idx" ON "groups" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "stores_name_trgm_idx" ON "stores" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "store_items_name_trgm_idx" ON "store_items" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "professional_listings_title_trgm_idx" ON "professional_listings" USING GIN ("profession_title" gin_trgm_ops);
