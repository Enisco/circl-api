/*
 * `prisma migrate dev` cannot be used on this schema, so this stands where it used to.
 *
 * Three indexes are partial — a unique index with a WHERE clause is a rule Postgres can be told and
 * a Prisma schema cannot describe. `migrate dev` sees them in the database, cannot find them in the
 * schema, calls that drift, and offers to reset the schema to resolve it. That is every row in the
 * database, and it has been offered four times.
 */
console.error(`
  prisma migrate dev is not the command here.

  It reads the three partial indexes as drift and offers to reset the schema —
  which is the whole database, and is never what you wanted.

  Instead:

    pnpm db:migrate-new <name>     writes the migration, touching nothing
    (read the file it names)
    pnpm db:migrate-deploy         applies it

  If you truly mean it, run npx prisma migrate dev yourself and read what it asks.
`);

process.exit(1);
