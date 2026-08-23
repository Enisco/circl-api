#!/usr/bin/env bash
# Creates a migration from the current schema, preserving the hand-written
# indexes in prisma/sql/extra-indexes.sql.
#
# `prisma migrate diff` cannot see those indexes, so it emits a DROP for each one
# on every run. This strips those DROPs and replays the file at the end, which is
# why the file has to stay idempotent.
#
#   ./scripts/new-migration.sh add_something
set -euo pipefail

NAME="${1:?usage: ./scripts/new-migration.sh <migration_name>}"
DIR="prisma/migrations/$(date +%Y%m%d%H%M%S)_${NAME}"
EXTRA="prisma/sql/extra-indexes.sql"

mkdir -p "$DIR"
npx prisma migrate diff --from-config-datasource --to-schema prisma --script -o "$DIR/migration.sql"

# Drop the "-- DropIndex" + statement pairs that only exist because Prisma cannot
# see these indexes. Matched by name against the file that owns them.
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

open(migration, 'w').write(''.join(out).rstrip('\n') + '\n\n' + open(extra).read())
PY

echo "Wrote $DIR/migration.sql"
echo "Review it, then: npx prisma migrate deploy"
