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

## The suites

| Script | Covers |
| --- | --- |
| `community.e2e.cjs` | Section 1: feed, requests, responses, offers, updates, guides, groups, moderation |
| `professionals.e2e.cjs` | Section 2 and Circl Trust: listings, promotion, browse, bookings, reviews, Smart Match, disputes |
| `connect.e2e.cjs` | Section 3: the continuity contract, the 18 gate, discovery, requests |
| `commerce.e2e.cjs` | Section 4: stores, address safety, items, cart, enquiries, demand hints |
| `messaging.e2e.cjs` | Section 5, including live WebSocket round-trips |
| `guard-admin.e2e.cjs` | Circl Guard and the staff endpoints |
| `intelligence-deletion.e2e.cjs` | Auto-Guides, Guided Creation, Pulse, and account deletion (0.15) |

Run them all:

```bash
for f in test/e2e/*.e2e.cjs; do node "$f" || exit 1; done
```
