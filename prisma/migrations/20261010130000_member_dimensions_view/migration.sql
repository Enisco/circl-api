-- ═════════════════════════════════════════════════════════════════════════════
-- `mv_member_dimensions` — one row per member, every dimension analytics filters on (§8.2).
--
-- Every filtered analytics query starts `WITH pop AS (SELECT user_id FROM mv_member_dimensions
-- WHERE …)`. Without it each one joins `users` to `user_profile` to `cities` and unpacks two JSONB
-- arrays, which is the same work repeated in a dozen places and indexed in none of them.
--
-- A materialized view and not a plain one on purpose: the point is the indexes. A plain view cannot
-- carry any, so `WHERE heritage_tag = …` over a hundred thousand members would be a sequential scan
-- of the join every time somebody moved a filter chip.
--
-- Refreshed CONCURRENTLY every fifteen minutes by `analytics.refresh-member-dimensions`, which is
-- why the unique index below exists — `CONCURRENTLY` refuses to run without one. Fifteen minutes of
-- staleness is invisible in a demographic breakdown and is the difference between a refresh that
-- blocks readers and one that does not.
--
-- Prisma does not know about materialized views, so `migrate diff` neither creates nor drops this.
-- Idempotent throughout: Prisma runs a migration outside a transaction, so a failure part-way
-- through leaves what came before it applied.
-- ═════════════════════════════════════════════════════════════════════════════

DROP MATERIALIZED VIEW IF EXISTS "mv_member_dimensions";

CREATE MATERIALIZED VIEW "mv_member_dimensions" AS
SELECT
  u."id"                                                           AS user_id,
  u."created_at"                                                   AS created_at,
  (u."created_at" AT TIME ZONE 'Europe/London')::date              AS created_day,
  u."status"::text                                                 AS status,
  u."signup_method"::text                                          AS signup_method,
  u."last_platform"::text                                          AS platform,
  u."last_app_version"                                             AS app_version,
  (u."last_active_at" AT TIME ZONE 'Europe/London')::date          AS last_active_day,
  p."city_id"                                                      AS city_id,
  c."region"                                                       AS region,
  p."gender"::text                                                 AS gender,
  -- The date, not a band. A band computed at refresh time is wrong for any range that ends in the
  -- past, and the bounds live in the `CONNECT_AGE_BAND` taxonomy where staff can reword them — so
  -- the band is derived at query time from the date, against the same bounds the member filter uses.
  p."date_of_birth"                                                AS date_of_birth,
  p."country_of_origin_code"                                       AS country_code,
  p."heritage_tag"                                                 AS heritage_tag,
  p."journey_stage"                                                AS journey_stage,
  -- JSONB to `text[]`, so a containment test is `&&` against a GIN index rather than a function
  -- call per row. `'[]'` and SQL NULL both become an empty array: "no interests recorded" is one
  -- state, and two spellings of it is a bug waiting in every `cardinality()`.
  COALESCE(
    ARRAY(SELECT jsonb_array_elements_text(p."interests") WHERE jsonb_typeof(p."interests") = 'array'),
    '{}'::text[]
  )                                                                AS interests,
  COALESCE(
    ARRAY(SELECT jsonb_array_elements_text(p."languages") WHERE jsonb_typeof(p."languages") = 'array'),
    '{}'::text[]
  )                                                                AS languages,
  COALESCE(p."onboarding_completed", false)                        AS onboarding_completed
FROM "users" u
LEFT JOIN "user_profile" p ON p."user_id" = u."id"
LEFT JOIN "cities" c ON c."id" = p."city_id"
-- Who counts as a member, once, here — the same three conditions `MemberFilterBuilder.POPULATION`
-- applies. Staff are listed under Team and would otherwise appear in the demographics of a product
-- they work on; an anonymised account has no personal data left and would quietly grow every
-- "unknown" bucket.
WHERE u."is_staff" = false
  AND u."is_anonymised" = false
  AND u."deleted_at" IS NULL;

-- Required by `REFRESH … CONCURRENTLY`, and the lookup every `pop` join uses.
CREATE UNIQUE INDEX IF NOT EXISTS "mv_member_dimensions_user_id_idx"
  ON "mv_member_dimensions" ("user_id");

CREATE INDEX IF NOT EXISTS "mv_member_dimensions_created_day_idx" ON "mv_member_dimensions" ("created_day");
CREATE INDEX IF NOT EXISTS "mv_member_dimensions_last_active_day_idx" ON "mv_member_dimensions" ("last_active_day");
CREATE INDEX IF NOT EXISTS "mv_member_dimensions_city_id_idx" ON "mv_member_dimensions" ("city_id");
CREATE INDEX IF NOT EXISTS "mv_member_dimensions_status_idx" ON "mv_member_dimensions" ("status");
CREATE INDEX IF NOT EXISTS "mv_member_dimensions_gender_idx" ON "mv_member_dimensions" ("gender");
CREATE INDEX IF NOT EXISTS "mv_member_dimensions_dob_idx" ON "mv_member_dimensions" ("date_of_birth");
CREATE INDEX IF NOT EXISTS "mv_member_dimensions_country_idx" ON "mv_member_dimensions" ("country_code");
CREATE INDEX IF NOT EXISTS "mv_member_dimensions_heritage_idx" ON "mv_member_dimensions" ("heritage_tag");
CREATE INDEX IF NOT EXISTS "mv_member_dimensions_journey_idx" ON "mv_member_dimensions" ("journey_stage");
CREATE INDEX IF NOT EXISTS "mv_member_dimensions_signup_method_idx" ON "mv_member_dimensions" ("signup_method");
CREATE INDEX IF NOT EXISTS "mv_member_dimensions_platform_idx" ON "mv_member_dimensions" ("platform");
CREATE INDEX IF NOT EXISTS "mv_member_dimensions_app_version_idx" ON "mv_member_dimensions" ("app_version");
CREATE INDEX IF NOT EXISTS "mv_member_dimensions_onboarding_idx" ON "mv_member_dimensions" ("onboarding_completed");

-- `&&` ("overlaps") against these is what makes "holds any of these codes" an index lookup.
CREATE INDEX IF NOT EXISTS "mv_member_dimensions_interests_idx" ON "mv_member_dimensions" USING GIN ("interests");
CREATE INDEX IF NOT EXISTS "mv_member_dimensions_languages_idx" ON "mv_member_dimensions" USING GIN ("languages");
