#!/bin/sh
set -e

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "Applying database migrations..."
  npx prisma migrate deploy
fi

if [ "${RUN_SEED:-false}" = "true" ]; then
  echo "Running database seed..."
  npx prisma db seed
fi

exec "$@"
