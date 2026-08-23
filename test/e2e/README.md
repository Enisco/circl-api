# End-to-end checks

These run against a **live server and a real database**, which is the only way to
exercise the guard chain, the response envelope, the exception filter and the
Prisma constraints together. They are deliberately not Jest specs: a Jest run
that boots Nest and a database is slower and no more truthful than curling the
thing you actually deploy.

Each script creates its own throwaway users, exercises the flows, and deletes
everything it made before exiting.

```bash
pnpm build && node dist/src/main &     # or pnpm start:dev
node test/e2e/community.e2e.cjs        # Section 1
```

Exit code is non-zero if any check fails, so they can go in CI behind a service
container without further plumbing.
