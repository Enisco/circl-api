import { PrismaClient } from '@prisma/client';

/**
 * Approved listing reviews become approved category verifications (v2 §7).
 *
 * **Nobody who has already been through a review is asked to do it again.** That is the one
 * migration failure members would notice: they sent a licence, a human read it, and v2 would have
 * met them with "this kind of work has to be verified before you can offer it".
 *
 * ## Why this is a seeder and not the migration that wrote the rest of v2's data
 *
 * It was in the migration, and it quietly did nothing there. The rule is "carry the approval over
 * for any category somebody now needs verifying for" — a gate on the category, or on any of its
 * subcategories — and **the subcategories are seeded, not migrated**. `start:prod` is
 * `prisma migrate deploy && node dist/src/main`, so at migration time `taxonomy_terms` holds no
 * `PROFESSION_SUBCATEGORY` row at all: the `EXISTS` found nothing, no verification was inserted,
 * and no document was re-pointed. On a fresh database that is invisible, because there are no
 * listings to carry over — it would only ever have failed on the database that actually has
 * members on it, which is the one case the statement exists for.
 *
 * So it runs here, immediately after `seedTaxonomy`, where the gates it reads are the gates that
 * will be in force. The statements in the migration are left alone rather than edited: Prisma
 * checksums an applied migration, and they are idempotent no-ops once this has run.
 *
 * ## Safe on every boot
 *
 * Both statements are re-runnable, which is what lets this live in a seed that runs on every
 * start. `ON CONFLICT (user_id, category_code) DO NOTHING` means a record that already exists is
 * never touched — including one staff have since **revoked**, because the conflict is on the pair
 * and not on the status. The document move only matches media still owned by a listing, so once
 * they have moved there is nothing left to match.
 *
 * The one state it cannot defend against is a verification row deleted outright, which would be
 * re-created as approved on the next boot. Nothing exposes a delete — revoking is the operation —
 * so that would mean somebody working in the database by hand.
 */
export const carryOverListingApprovals = async (
  prisma: PrismaClient,
  log?: { info: (message: string) => void },
): Promise<{ verifications: number; documents: number }> => {
  /**
   * One record per gated category an approved listing holds, with the original decision's dates
   * and the note the member was shown.
   *
   * Only where the category is one somebody now needs verifying for: an approval for ungated work
   * would be a badge nobody earned. `licenceSeen` is deliberately left null — nobody recorded one
   * at the time, and inventing a value is worse than an honest gap — and `note` says where the
   * approval came from, so a reviewer reading the record later knows it was not a document check
   * of this category.
   */
  const verifications = await prisma.$executeRaw`
    INSERT INTO "category_verifications" (
      "id",
      "user_id",
      "category_code",
      "status",
      "submitted_for_subcategories",
      "note",
      "submitted_at",
      "decided_at",
      "decided_by_id",
      "decision_note",
      "checked_by",
      "created_at",
      "updated_at"
    )
    SELECT
      gen_random_uuid(),
      l."user_id",
      c."code",
      'APPROVED',
      ARRAY[]::text[],
      'Carried over from the profile review approved on ' ||
        to_char(COALESCE(l."review_decided_at", l."updated_at"), 'FMDD FMMonth YYYY') || '.',
      COALESCE(l."review_submitted_at", l."created_at"),
      COALESCE(l."review_decided_at", l."updated_at"),
      l."review_decided_by_id",
      l."review_note",
      'Circl Trust & Safety',
      NOW(),
      NOW()
    FROM "professional_listings" AS l
    JOIN "professional_listing_categories" AS c ON c."listing_id" = l."id"
    JOIN "taxonomy_terms" AS t ON t."kind" = 'PROFESSION' AND t."code" = c."code"
    WHERE l."review_state" = 'APPROVED'
      AND l."deleted_at" IS NULL
      AND (
        COALESCE(t."metadata" -> 'requiresVerification', 'false'::jsonb) = 'true'::jsonb
        OR EXISTS (
          SELECT 1
          FROM "taxonomy_terms" AS child
          WHERE child."kind" = 'PROFESSION_SUBCATEGORY'
            AND child."metadata" ->> 'parentCode' = c."code"
            AND COALESCE(child."metadata" -> 'requiresVerification', 'false'::jsonb) = 'true'::jsonb
        )
      )
    ON CONFLICT ("user_id", "category_code") DO NOTHING
  `;

  /**
   * The documents that approval rested on follow it, for the listing's **primary** category.
   *
   * Re-pointed rather than copied: the same bytes under two owners would be two retention clocks
   * and two chances to delete the wrong one. The listing review keeps its decision, its dates and
   * its note; what moves is the evidence, to the record that now carries the approval.
   *
   * Only the primary category, because a file has one owner and the review was predominantly about
   * the work the listing leads with. A professional approved for two gated categories gets the
   * second record with no documents attached, which reads correctly: the approval stands, and the
   * paperwork is filed under the first.
   */
  const documents = await prisma.$executeRaw`
    UPDATE "media" AS m
    SET "owner_type" = 'CATEGORY_VERIFICATION', "owner_id" = v."id"
    FROM "professional_listings" AS l
    JOIN "professional_listing_categories" AS c
      ON c."listing_id" = l."id" AND c."is_primary" = true
    JOIN "category_verifications" AS v
      ON v."user_id" = l."user_id" AND v."category_code" = c."code"
    WHERE m."owner_type" = 'LISTING_DOCUMENT'
      AND m."owner_id" = l."id"
      AND m."superseded_at" IS NULL
      AND v."status" = 'APPROVED'
  `;

  // Silent when there is nothing to do, which is every boot after the first. A line per boot
  // saying "0 carried over" is the kind of noise that teaches people to skip the startup log.
  if (verifications || documents) {
    log?.info(
      `Carried ${verifications} listing approval(s) over to category verifications, moving ${documents} document(s).`,
    );
  }

  return { verifications, documents };
};
