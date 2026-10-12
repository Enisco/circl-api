-- Two things the admin filter bar needs, neither of them a schema change.
--
-- Prisma does not wrap a migration in a transaction, so every statement here is idempotent and
-- safe to replay.

-- ── The index behind "which builds are still in the wild" ────────────────────
--
-- GET admin/analytics/filter-options runs a DISTINCT over every session row every ten minutes.
-- Leading on the two projected columns so the DISTINCT comes free from index order rather than a
-- sort, and partial because a session with no recorded build is not an answer. Sessions grow as
-- members times devices, so without it this is a sequential scan that gets slower every week.
--
-- Also asserted by src/infrastructure/database/startup-indexes.ts on every boot, and listed in
-- prisma/sql/extra-indexes.sql, because Prisma cannot express a partial index and proposes
-- DROPping it from every migration generated afterwards.
CREATE INDEX IF NOT EXISTS "user_sessions_app_version_idx"
  ON "user_sessions" ("app_version", "platform", "last_active_at")
  WHERE "app_version" IS NOT NULL;

-- ── Regions for the cities that already had the column ──────────────────────
--
-- "cities".region has existed since the first migration and nothing ever wrote it, so the filter
-- bar grouped all 103 cities under nothing -- and the six member-facing selects that already read
-- region were returning null. The seeder fills it from prisma/seeders/data/uk-cities.json; this
-- backfills a database that will not be reseeded, with the ITL level-1 regions the ONS uses.
--
-- Written as one UPDATE per region rather than 103 statements, and only where the column is still
-- null, so a deployment that has already been seeded is untouched.
UPDATE "cities" SET "region" = v."region"
FROM (VALUES
  ('North East', ARRAY['DURHAM','MIDDLESBROUGH','NEWCASTLE','SUNDERLAND']),
  ('North West', ARRAY['BIRKENHEAD','BLACKBURN','BLACKPOOL','BOLTON','BURNLEY','CARLISLE','CHESTER','LANCASTER','LIVERPOOL','MANCHESTER','OLDHAM','PRESTON','ROCHDALE','SALFORD','WARRINGTON','WIGAN']),
  ('Yorkshire and the Humber', ARRAY['BARNSLEY','BRADFORD','DONCASTER','GRIMSBY','HARROGATE','HUDDERSFIELD','HULL','LEEDS','RIPON','ROTHERHAM','SHEFFIELD','WAKEFIELD','YORK']),
  ('East Midlands', ARRAY['DERBY','LEICESTER','LINCOLN','NORTHAMPTON','NOTTINGHAM']),
  ('West Midlands', ARRAY['BIRMINGHAM','COVENTRY','HEREFORD','LICHFIELD','STOKE_ON_TRENT','TELFORD','WOLVERHAMPTON','WORCESTER']),
  ('East of England', ARRAY['BASILDON','BEDFORD','CAMBRIDGE','CHELMSFORD','COLCHESTER','ELY','IPSWICH','LUTON','NORWICH','PETERBOROUGH','SOUTHEND_ON_SEA','ST_ALBANS','WATFORD']),
  ('London', ARRAY['LONDON']),
  ('South East', ARRAY['BRIGHTON','CANTERBURY','CHICHESTER','CRAWLEY','EASTBOURNE','GUILDFORD','MAIDSTONE','MILTON_KEYNES','OXFORD','PORTSMOUTH','READING','SLOUGH','SOUTHAMPTON','WINCHESTER','WORTHING']),
  ('South West', ARRAY['BATH','BOURNEMOUTH','BRISTOL','CHELTENHAM','EXETER','GLOUCESTER','PLYMOUTH','SALISBURY','SWINDON','TRURO','WELLS']),
  ('Wales', ARRAY['BANGOR','CARDIFF','NEWPORT','SWANSEA','WREXHAM']),
  ('Scotland', ARRAY['ABERDEEN','DUNDEE','EDINBURGH','GLASGOW','INVERNESS','PERTH','STIRLING']),
  ('Northern Ireland', ARRAY['ARMAGH','BELFAST','DERRY','LISBURN','NEWRY'])
) AS v("region", "ids")
WHERE "cities"."id" = ANY(v."ids") AND "cities"."region" IS NULL;
