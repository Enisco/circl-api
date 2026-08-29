import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TaxonomyKind } from '@prisma/client';
import OpenAI from 'openai';
import { PrismaService } from '@/infrastructure';
import { addDays, ApiErrorCode, ApiException, money } from '@/common';
import { MediaService, TaxonomyService } from '../../shared';
import { AiDraftItemsDto } from '../dtos/store.dto';

/** The AI storefront builder (4.9). */
@Injectable()
export class AiDraftService {
  private readonly logger = new Logger(AiDraftService.name);
  private readonly client: OpenAI | null;

  /** Below this the model did not really identify the product. */
  private static readonly DESCRIPTION_CONFIDENCE = 0.6;

  /** Below this, do not suggest a price at all. */
  private static readonly PRICE_CONFIDENCE = 0.75;

  private static readonly DRAFT_TTL_DAYS = 7;

  constructor(
    private readonly database: PrismaService,
    private readonly config: ConfigService,
    private readonly media: MediaService,
    private readonly taxonomy: TaxonomyService,
  ) {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');

    this.client = apiKey ? new OpenAI({ apiKey }) : null;
  }

  async draftItems(userId: string, dto: AiDraftItemsDto) {
    if (!this.client) {
      throw ApiException.unprocessable(
        ApiErrorCode.INTERNAL_ERROR,
        'The storefront builder is not available right now. You can still add items by hand.',
      );
    }

    const photos = await this.media.validate(dto.mediaKeys, userId, {
      maxImages: 10,
      allowVideo: false,
      allowAudio: false,
    });

    const job = await this.database.aiDraftJob.create({
      data: { userId, storeId: dto.storeId ?? null, tone: dto.tone ?? 'WARM', state: 'RUNNING' },
    });

    const [categories, units, anchors] = await Promise.all([
      this.taxonomy.list(TaxonomyKind.ITEM_CATEGORY),
      this.taxonomy.list(TaxonomyKind.ITEM_UNIT),
      dto.storeId ? this.priceAnchors(dto.storeId) : Promise.resolve([]),
    ]);

    try {
      const drafts = await Promise.all(
        photos.map(photo =>
          this.draftOne(this.media.sign(photo.storageKey), dto.tone ?? 'WARM', categories, units, anchors),
        ),
      );

      const rows = await this.database.$transaction(
        drafts.map((draft, index) =>
          this.database.aiItemDraft.create({
            data: {
              jobId: job.id,
              userId,
              storeId: dto.storeId ?? null,
              sourceMediaId: photos[index].id,
              name: draft.name,
              description: draft.description,
              categoryCode: draft.categoryCode,
              unitCode: draft.unitCode,
              suggestedPrice: draft.suggestedPrice,
              confidence: draft.confidence,
              expiresAt: addDays(new Date(), AiDraftService.DRAFT_TTL_DAYS),
            },
          }),
        ),
      );

      await this.database.aiDraftJob.update({
        where: { id: job.id },
        data: { state: 'DONE', completedAt: new Date() },
      });

      return {
        jobId: job.id,
        state: 'DONE',
        drafts: rows.map(row => this.toView(row)),
      };
    } catch (error) {
      await this.database.aiDraftJob.update({
        where: { id: job.id },
        data: { state: 'FAILED', error: (error as Error).message, completedAt: new Date() },
      });

      this.logger.warn(`AI draft job ${job.id} failed: ${(error as Error).message}`);

      throw ApiException.unprocessable(
        ApiErrorCode.INTERNAL_ERROR,
        'We could not read those photos. You can still add the items by hand.',
      );
    }
  }

  /** The polling route for when a job is slow enough to need one (4.9). */
  async jobStatus(userId: string, jobId: string) {
    const job = await this.database.aiDraftJob.findUnique({ where: { id: jobId } });

    if (!job || job.userId !== userId) {
      throw ApiException.notFound('That job could not be found.');
    }

    const drafts = await this.database.aiItemDraft.findMany({
      where: { jobId },
      orderBy: { createdAt: 'asc' },
    });

    return { jobId: job.id, state: job.state, drafts: drafts.map(row => this.toView(row)) };
  }

  private async draftOne(
    imageUrl: string | null,
    tone: string,
    categories: Array<{ code: string; label: string }>,
    units: Array<{ code: string; label: string }>,
    anchors: Array<{ name: string; price: number }>,
  ) {
    const empty = {
      name: null as string | null,
      description: null as string | null,
      categoryCode: null as string | null,
      unitCode: null as string | null,
      suggestedPrice: null as number | null,
      confidence: 0,
    };

    if (!imageUrl) return empty;

    const system = [
      'You help an immigrant-owned shop in the UK list a product from one photograph.',
      'Reply with JSON only, matching this shape exactly:',
      '{"name":string|null,"description":string|null,"categoryCode":string|null,"unitCode":string|null,"suggestedPricePence":number|null,"confidence":number}',
      '',
      `Valid categoryCode values: ${categories.map(c => c.code).join(', ')}.`,
      `Valid unitCode values: ${units.map(u => u.code).join(', ')}.`,
      '',
      'Rules you must follow:',
      '- confidence is 0..1 and reflects how certain you are about what the product actually is.',
      '- If you cannot identify the specific product, set name to your best short guess and set description to null. Never invent prose about a product you could not identify.',
      '- Only suggest a price when you are confident and the comparable prices support it. Otherwise set suggestedPricePence to null.',
      '- Never claim a product is organic, halal, authentic, medicinal or has any health benefit.',
      '- Write in British English.',
      toneInstruction(tone),
      anchors.length
        ? `Comparable prices already in this shop (pence): ${anchors.map(a => `${a.name} ${a.price}`).join('; ')}.`
        : 'This shop has no comparable prices yet, so prefer null for suggestedPricePence.',
    ].join('\n');

    const response = await this.client!.chat.completions.create({
      model: this.config.get<string>('OPENAI_MODEL') || 'gpt-4o',
      temperature: 0.2,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Draft a listing for this product.' },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
    });

    const parsed = safeParse(response.choices[0]?.message?.content);

    if (!parsed) return empty;

    const confidence = clamp01(Number(parsed.confidence) || 0);
    const categoryCode = categories.some(c => c.code === parsed.categoryCode)
      ? (parsed.categoryCode as string)
      : null;
    const unitCode = units.some(u => u.code === parsed.unitCode)
      ? (parsed.unitCode as string)
      : null;

    return {
      name: typeof parsed.name === 'string' ? parsed.name.slice(0, 100) : null,
      // Enforced here rather than trusted to the prompt.
      description:
        confidence >= AiDraftService.DESCRIPTION_CONFIDENCE &&
        typeof parsed.description === 'string'
          ? parsed.description.slice(0, 1000)
          : null,
      categoryCode,
      unitCode,
      suggestedPrice:
        confidence >= AiDraftService.PRICE_CONFIDENCE &&
        anchors.length > 0 &&
        Number.isInteger(parsed.suggestedPricePence) &&
        (parsed.suggestedPricePence as number) > 0
          ? (parsed.suggestedPricePence as number)
          : null,
      confidence,
    };
  }

  /** What this shop already charges, so a suggestion is anchored rather than guessed. */
  private async priceAnchors(storeId: string) {
    const items = await this.database.storeItem.findMany({
      where: { storeId, deletedAt: null },
      select: { name: true, price: true },
      take: 20,
    });

    return items;
  }

  private toView(row: {
    id: string;
    sourceMediaId: string | null;
    name: string | null;
    description: string | null;
    categoryCode: string | null;
    unitCode: string | null;
    suggestedPrice: number | null;
    confidence: number;
  }) {
    return {
      draftId: row.id,
      sourceMediaId: row.sourceMediaId,
      name: row.name,
      description: row.description,
      categoryCode: row.categoryCode,
      unitCode: row.unitCode,
      // Always editable.
      suggestedPrice: money(row.suggestedPrice),
      confidence: Number(row.confidence.toFixed(2)),
    };
  }
}

const toneInstruction = (tone: string): string => {
  switch (tone) {
    case 'SHORT':
      return 'Keep the description to one short sentence.';
    case 'FORMAL':
      return 'Write the description plainly and formally, with no exclamation marks.';
    default:
      return 'Write the description warmly, as a shopkeeper would describe it to a regular.';
  }
};

const safeParse = (content: string | null | undefined): Record<string, unknown> | null => {
  if (!content) return null;

  try {
    const parsed: unknown = JSON.parse(content);

    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
