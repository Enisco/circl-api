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
| `validation.e2e.cjs` | Every boundary in the Section 1 validation summary (1.11) — one below and one at each limit |
| `validation-sections.e2e.cjs` | The same for 2.13, 3.8, 4.12, 5.9, and the media rules in 0.11 |
| `response-shapes.e2e.cjs` | Every field the spec's JSON examples show, checked present on a live payload |
| `spec-conformance.e2e.cjs` | The defects the spec audit found, so they cannot come back |
| `rate-limits.e2e.cjs` | 0.14 limits are per member, not per IP |

Run them all:

```bash
redis-cli FLUSHDB                                   # clears rate-limit counters
for f in test/e2e/*.e2e.cjs; do node "$f" || exit 1; done
```

Flush Redis first. The suites create a lot of content per member and the
per-member limits from 0.14 are real, so a run straight after another one can
trip the hourly creation limit and fail for a reason that has nothing to do with
the code.
