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

## Migrations

`prisma migrate dev` is not the command here, and `pnpm db:migrate-dev` says so. Three of our
indexes are partial, which a Prisma schema cannot describe, so it reads them as drift and offers to
reset the schema — the whole database. It has offered four times.

```bash
pnpm db:migrate-new add_something   # writes the migration, touching nothing
#   read the file it names
pnpm db:migrate-deploy              # applies it
```

**In production, `prisma migrate deploy` and nothing else.** It applies pending migrations in order
and does nothing else: no shadow database, no drift check, no prompt, and no path that drops or
resets anything. `start:prod` already runs it before the server starts, and stops on a non-zero exit
so the app never boots against a half-migrated database.

The safety is in the file, not the command: `deploy` will run whatever a migration says, including a
`DROP`. Which is why generating and applying are two steps with a read in between.

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
| `deals.e2e.cjs` | Deal progress: the spine, who may mark what, confirmed-only earnings, and the review gate |
| `admin-meta.e2e.cjs` | §5.27: the portal's vocabularies, assignable staff per queue, and the command palette |
| `content-safety.e2e.cjs` | §6.2–6.7: the lexicon pipeline — tiers, the safeguarding floor, the queue item, the hash that stops a no-op edit re-scanning, and every community write path |
| `content-visibility.e2e.cjs` | §6.5: what a held or limited piece of content does to every surface that reads it — lists, feed, search, threads, directory, shop, discovery, and the single-item 404 |
| `message-safety.e2e.cjs` | §6.8: the private-message scan — what it watches, who the case is about, the group and Guard-thread rules, and the message staying delivered and unmarked whatever it found |
| `image-safety.e2e.cjs` | §6.1's last row: an avatar scanned on its own target, its verdict on the image rather than on the profile, a replacement scanned in turn, and staff removing one leaving the member standing |
| `report-cases.e2e.cjs` | §7.1: reports grouped into one case per target, the priority rules, the SLA clock, a dismissal that stands for a week, and a decision on removed content answering the next report |
| `report-workflow.e2e.cjs` | §5.10 and §7.2: the report queue a reviewer works, claiming and releasing, the four-role permission matrix, and everything a decision sets off — content, reports, strike, queue item and the reporters |
| `appeals.e2e.cjs` | §5.11: an appeal logged by staff in the member's words, R6 stopping the original decider reviewing it, and what overturning undoes — the post back, the strike withdrawn, the case marked reversed |
| `moderation-queue.e2e.cjs` | §5.9: the queue a reviewer works — CSV filters, a band and a deadline on every item, `allowedDecisions` from the server, claim/release/assign, and the three decisions that used to do nothing (a warning that warns, an approval that publishes, a rejection the author can read) |
| `moderation-queue.e2e.cjs` | §5.9: the queue a reviewer works — CSV filters, a band and a deadline on every item, `allowedDecisions` from the server, claim/release/assign, and the three decisions that used to do nothing (a warning that warns, an approval that publishes, a rejection the author can read) |
| `listing-documents.e2e.cjs` | §2.9 documents: PDFs for this purpose only, 1–5 enforced, the bytes deciding the type over the declared one, EXIF stripped before storage, one listing per document, Support refused, the audit entry throttled, and a resubmission superseding what it replaced without deleting it |
| `listing-review.e2e.cjs` | §2.9 and §13.2: a listing in a gated profession held until somebody approves it, a decline the member can act on, a fix that resubmits, an approval that publishes — and a suspended member who is finally told they are suspended, with the end date and where to appeal |
| `admin-exports.e2e.cjs` | §5.26: the column allowlist, contact columns, the filters being the list's filters, every kind's file counted against its own list, the content export refusing a type-specific filter, twenty an hour, owner-only downloads, and the seven-day sweep |
| `admin-audit.e2e.cjs` | §5.23, S11 and §13.6: the trail read under all three R8 scopes, the jobs screen, S11.3's hash chain — a sealed stretch proved to notice a row changed, removed or inserted, and put back — and every retention rule checked against an old row *and* a recent one |

Run them all, and **read the report rather than the last line**:

```bash
redis-cli FLUSHDB                                   # clears rate-limit counters
: > /tmp/sweep.txt
for f in test/e2e/*.e2e.cjs; do
  echo "═══ running $f" >> /tmp/sweep.txt
  node "$f" >> /tmp/sweep.txt 2>&1
done
node scripts/sweep-report.mjs /tmp/sweep.txt
```

Summing the `N passed, M failed` lines is not enough: a suite that **crashes** never prints one, so
its checks are missing from both totals and the sweep reads as clean. Three suites crashed on a
newly-required column for two stages while the tally said "0 failed" every time.
`sweep-report.mjs` reports suites started against suites finished, and exits non-zero on either.

Flush Redis first. The suites create a lot of content per member and the
per-member limits from 0.14 are real, so a run straight after another one can
trip the hourly creation limit and fail for a reason that has nothing to do with
the code.
