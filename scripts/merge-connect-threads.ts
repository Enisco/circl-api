import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';
import { Pool } from 'pg';

/**
 * Folds the duplicate Connect conversations a pair of members already have into one.
 *
 * Connect threads used to be keyed on `(pair, CONNECT_PROFILE, profileId)`, so writing to somebody
 * from a second profile opened a second conversation and stranded the reply in whichever was
 * first. The live path no longer does that — it matches on the pair and ignores the profile id —
 * but convergence only stops new duplicates. The rows already written are still two threads with
 * one person at the top of an inbox, which is what members judge.
 *
 * **The survivor is the one most recently written in**, by `lastMessageAt` then `createdAt` — the
 * same rule `ConversationFactoryService.ensure` now applies and the same one the app picks, so a
 * merge lands on the thread both sides already open and nobody sees a conversation move.
 *
 * It refuses more than it fixes, on purpose. A conversation is the two people in it, and a merge
 * that goes wrong is worse than the duplicate it tidies: anything attached to a thread that this
 * script cannot move — a deal, a booking, an order, a dispute, a support or Guard thread, a
 * review, a group — makes that whole pair a **blocker**, reported and left alone. Nothing is
 * guessed and nothing is deleted that was not first moved.
 *
 *   pnpm merge:connect-threads            # dry run: reports, writes nothing
 *   pnpm merge:connect-threads --write    # merges the pairs that have no blockers
 *   pnpm merge:connect-threads --write --limit 50
 */

/** A row pointing at a doomed thread that this script will not move. */
interface Blocker {
  what: string;
  count: number;
}

interface Pair {
  participantKey: string;
  survivorId: string;
  /** Oldest first, which is the order they are folded in. */
  doomed: Array<{ id: string; messages: number; contextId: string | null }>;
  survivorMessages: number;
  blockers: Blocker[];
  /** `(conversationId, clientId)` is unique, so a repeated clientId cannot simply be repointed. */
  clientIdClashes: number;
}

const main = async () => {
  const write = process.argv.includes('--write');
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg === -1 ? Infinity : Number(process.argv[limitArg + 1] ?? Infinity);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool as unknown as ConstructorParameters<typeof PrismaPg>[0]);
  const prisma = new PrismaClient({ adapter, log: ['error'] });

  try {
    // Every pair holding more than one Connect thread, newest-written first within a pair.
    const groups = await prisma.$queryRaw<Array<{ participant_key: string; ids: string[] }>>`
      SELECT "participant_key",
             array_agg("id" ORDER BY "last_message_at" DESC NULLS LAST, "created_at" DESC) AS ids
      FROM "conversations"
      WHERE "context_type" = 'CONNECT_PROFILE'
      GROUP BY "participant_key"
      HAVING count(*) > 1
    `;

    if (!groups.length) {
      console.info('No pair holds more than one Connect conversation. Nothing to do.');

      return;
    }

    const pairs: Pair[] = [];

    for (const group of groups) {
      const [survivorId, ...doomedIds] = group.ids;

      // Counted rather than loaded: a pair with four hundred messages is not worth holding in
      // memory to report a number.
      const counts = new Map(
        (
          await prisma.message.groupBy({
            by: ['conversationId'],
            where: { conversationId: { in: group.ids } },
            _count: { _all: true },
          })
        ).map(row => [row.conversationId, row._count._all]),
      );

      const doomedRows = await prisma.conversation.findMany({
        where: { id: { in: doomedIds } },
        select: { id: true, contextId: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });

      const where = { conversationId: { in: doomedIds } };
      const blockers: Blocker[] = [];
      const note = async (what: string, count: Promise<number>) => {
        const found = await count;

        if (found) blockers.push({ what, count: found });
      };

      // Everything `Conversation` is the parent of, besides the three this script moves. A `Deal`
      // cascades on delete, so missing one here would destroy an agreement rather than orphan it.
      await note('deals', prisma.deal.count({ where }));
      await note('bookings', prisma.booking.count({ where }));
      await note('orders', prisma.enquiry.count({ where }));
      await note('disputes', prisma.dispute.count({ where }));
      await note('guard threads', prisma.guardThread.count({ where }));
      await note('support threads', prisma.supportThread.count({ where }));
      await note('managed requests', prisma.managedRequest.count({ where }));
      await note('reviews', prisma.review.count({ where }));
      await note('groups', prisma.group.count({ where }));

      // Columns that name a conversation without a foreign key: these would not stop a delete,
      // they would simply stop resolving afterwards, which is a dangling reference nobody is
      // watching for.
      await note('escalations', prisma.escalation.count({ where }));
      await note('service request offers', prisma.serviceRequestOffer.count({ where }));
      await note('staff thread access grants', prisma.threadAccessGrant.count({ where }));

      // A clientId is unique per conversation, so two threads may each hold one. Repointing the
      // second would violate that, and rewriting somebody's client id to dodge it would break the
      // echo the sending device matches on.
      const clientIds = await prisma.message.findMany({
        where: { conversationId: { in: doomedIds } },
        select: { clientId: true },
      });
      const survivorClientIds = new Set(
        (
          await prisma.message.findMany({
            where: { conversationId: survivorId },
            select: { clientId: true },
          })
        ).map(row => row.clientId),
      );
      const seen = new Set<string>();
      const clientIdClashes = clientIds.filter(row => {
        const clash = survivorClientIds.has(row.clientId) || seen.has(row.clientId);

        seen.add(row.clientId);

        return clash;
      }).length;

      pairs.push({
        participantKey: group.participant_key,
        survivorId,
        survivorMessages: counts.get(survivorId) ?? 0,
        doomed: doomedRows.map(row => ({
          id: row.id,
          contextId: row.contextId,
          messages: counts.get(row.id) ?? 0,
        })),
        blockers,
        clientIdClashes,
      });
    }

    const clear = pairs.filter(pair => !pair.blockers.length && !pair.clientIdClashes);
    const held = pairs.filter(pair => pair.blockers.length || pair.clientIdClashes);
    // The ones they asked to be told about before anything runs: messages on more than one side,
    // so a merge interleaves two real conversations rather than absorbing an empty room.
    const bothSides = clear.filter(
      pair => pair.survivorMessages > 0 && pair.doomed.some(row => row.messages > 0),
    );

    console.info(`\n${pairs.length} pair(s) hold more than one Connect conversation.`);
    console.info(`  ${clear.length} can be merged`);
    console.info(`  ${held.length} held back`);
    console.info(
      `  of the mergeable, ${bothSides.length} have real messages on more than one side\n`,
    );

    for (const pair of pairs) {
      const total = pair.doomed.reduce((sum, row) => sum + row.messages, pair.survivorMessages);
      const state = pair.blockers.length || pair.clientIdClashes ? 'HELD' : 'merge';

      console.info(
        `[${state}] ${pair.participantKey}  ${pair.doomed.length + 1} threads, ${total} message(s)`,
      );
      console.info(`    keep ${pair.survivorId}  (${pair.survivorMessages} message(s))`);

      for (const row of pair.doomed) {
        console.info(
          `    fold ${row.id}  (${row.messages} message(s), profile ${row.contextId ?? 'none'})`,
        );
      }

      for (const blocker of pair.blockers) {
        console.info(`    ✗ ${blocker.count} ${blocker.what} on a thread being folded`);
      }

      if (pair.clientIdClashes) {
        console.info(`    ✗ ${pair.clientIdClashes} message(s) whose client id is already in use`);
      }
    }

    if (!write) {
      console.info('\nDry run: nothing was written. Re-run with --write to merge the mergeable.');

      return;
    }

    let merged = 0;

    for (const pair of clear.slice(0, limit)) {
      const doomedIds = pair.doomed.map(row => row.id);

      // One transaction per pair, so a pair that fails leaves the others done and itself untouched.
      await prisma.$transaction(async tx => {
        await tx.message.updateMany({
          where: { conversationId: { in: doomedIds } },
          data: { conversationId: pair.survivorId },
        });

        // The connection request that opened the thread, so "message them" from the request still
        // resolves after the merge.
        await tx.connectionRequest.updateMany({
          where: { conversationId: { in: doomedIds } },
          data: { conversationId: pair.survivorId },
        });

        // Unread is per participant and both rows are the same two people, so the counts add: a
        // member with two unread in one thread and three in the other has five to read, and
        // resetting it to one side's number would hide messages they have not seen.
        const doomedParticipants = await tx.conversationParticipant.findMany({
          where: { conversationId: { in: doomedIds } },
        });

        for (const participant of doomedParticipants) {
          await tx.conversationParticipant.updateMany({
            where: { conversationId: pair.survivorId, userId: participant.userId },
            data: {
              unreadCount: { increment: participant.unreadCount },
              // Archived only if it was archived on both sides: a thread the member filed away
              // once and then wrote in again is not done.
              isArchived: participant.isArchived ? undefined : false,
              hasSentMessage: participant.hasSentMessage ? true : undefined,
            },
          });
        }

        // Cascades from here: participants and receipts of the folded rows, and nothing else,
        // because everything else was moved or made this pair a blocker.
        await tx.conversation.deleteMany({ where: { id: { in: doomedIds } } });

        // Recomputed from the rows rather than summed from the counts above, so the inbox's sort
        // key is true even if a message arrived while this ran.
        const [{ count, last }] = await tx.$queryRaw<Array<{ count: bigint; last: Date | null }>>`
          SELECT count(*) AS count, max("sent_at") AS last
          FROM "messages"
          WHERE "conversation_id" = ${pair.survivorId} AND "deleted_at" IS NULL
        `;

        await tx.conversation.update({
          where: { id: pair.survivorId },
          data: { messageCount: Number(count), lastMessageAt: last },
        });
      });

      merged += 1;
      console.info(`merged ${pair.participantKey} into ${pair.survivorId}`);
    }

    console.info(`\nMerged ${merged} pair(s). ${held.length} left alone.`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
};

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
