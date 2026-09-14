#!/usr/bin/env bash
# Writes a migration from the current schema, preserving the hand-written
# indexes in prisma/sql/extra-indexes.sql.
#
# `prisma migrate dev` cannot be used here. Three of our indexes are partial — a
# unique index with a WHERE clause is a rule Postgres can be told and a Prisma
# schema cannot describe — so it reads them as drift and offers to reset the
# schema, which is the whole database. It has offered four times.
#
# This diffs the live database against the schema instead: no shadow replay, no
# drift check, nothing written to the database. `prisma migrate diff` cannot see
# those indexes either and emits a DROP for each one, so the DROPs are stripped
# and the file is replayed at the end, which is why it has to stay idempotent.
#
#   pnpm db:migrate-new add_something
#   (read the file it names)
#   pnpm db:migrate-deploy
set -euo pipefail

NAME="${1:?usage: pnpm db:migrate-new <migration_name>}"
DIR="prisma/migrations/$(date +%Y%m%d%H%M%S)_${NAME}"
EXTRA="prisma/sql/extra-indexes.sql"

mkdir -p "$DIR"
npx prisma migrate diff --from-config-datasource --to-schema prisma --script -o "$DIR/migration.sql"

# Strips the "-- DropIndex" + statement pairs that exist only because Prisma
# cannot see these indexes, matched by name against the file that owns them,
# then appends that file. Exits 3 when nothing else is left to do.
set +e
python3 - "$DIR/migration.sql" "$EXTRA" <<'PY'
import re, sys

migration, extra = sys.argv[1], sys.argv[2]
owned = set(re.findall(r'CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "([^"]+)"', open(extra).read()))
lines = open(migration).read().splitlines(keepends=True)

out, index = [], 0
while index < len(lines):
    match = re.match(r'DROP INDEX "([^"]+)";', lines[index].strip())
    if match and match.group(1) in owned:
        # Also drop the "-- DropIndex" comment and the blank line above it.
        while out and out[-1].strip() in ('', '-- DropIndex'):
            out.pop()
        index += 1
        continue
    out.append(lines[index])
    index += 1

body = ''.join(out)
real = [line for line in body.splitlines() if line.strip() and not line.strip().startswith('--')]

# A run with nothing to migrate should leave nothing behind, rather than a
# migration whose only content is the replayed index file.
if not real:
    sys.exit(3)

open(migration, 'w').write(body.rstrip('\n') + '\n\n' + open(extra).read())
PY
STATUS=$?
set -e

if [ "$STATUS" = "3" ]; then
  rm -rf "$DIR"
  echo "Nothing to migrate: the database already matches the schema."
  exit 0
fi

if [ "$STATUS" != "0" ]; then
  rm -rf "$DIR"
  exit "$STATUS"
fi

echo "Wrote $DIR/migration.sql"
echo "Read it, then apply it with: pnpm db:migrate-deploy"
echo "Nothing has touched the database yet."
