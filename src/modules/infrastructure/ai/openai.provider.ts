import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import OpenAI from 'openai';

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
}

@Injectable()
export class OpenAIProvider {
  private readonly client: OpenAI;

  constructor(
    private readonly config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OpenAIProvider.name);
    this.client = new OpenAI({ apiKey: this.config.get<string>('OPENAI_API_KEY') });
  }

  async createChat(
    systemPrompt: string,
    userPrompt: string,
    forceJson = false,
    options?: ChatOptions,
  ): Promise<string> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.config.get<string>('OPENAI_MODEL')!,
        temperature: options?.temperature ?? Number(this.config.get('AI_TEMPERATURE')),
        max_tokens: options?.maxTokens ?? Number(this.config.get('AI_MAX_TOKENS')),
        ...(forceJson && { response_format: { type: 'json_object' } }),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });

      return response.choices[0].message.content ?? '';
    } catch (error) {
      this.logger.error(`OpenAI createChat failed: ${(error as Error).message}`);
      throw new InternalServerErrorException('Something went wrong. Failed to process AI response');
    }
  }

  /**
   * The moderation endpoint (§6.2 step 5), which is not a chat completion and is not billed.
   *
   * Deliberately **not** wrapped in the `InternalServerErrorException` the two methods above
   * throw: the content pipeline has to tell a timeout from a refusal from a bad response, because
   * each one has a different fail-safe (§6.7), and a 500 from here would be caught by a worker
   * that cannot see what happened. The error is passed through as it arrived.
   *
   * `timeoutMs` comes from `safety.classifier.timeoutMs`. It is enforced here rather than left to
   * the SDK's default, because the whole point of the provisional hold in §6.5 is that it lasts
   * seconds — a request that hangs for a minute holds a member's post for a minute.
   */
  async moderate(
    input: Array<
      { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
    >,
    model: string,
    timeoutMs: number,
  ): Promise<{ flagged: boolean; scores: Record<string, number> }> {
    const response = await this.client.moderations.create(
      { model, input },
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    const result = response.results[0];

    if (!result) throw new Error('The moderation endpoint returned no result.');

    return {
      flagged: result.flagged,
      // The SDK types these as a fixed record of its own category names; the pipeline reads them
      // by key, so they are flattened to numbers here and the multipliers decide what matters.
      scores: Object.fromEntries(
        Object.entries(result.category_scores as unknown as Record<string, number | null>).map(
          ([category, score]) => [category, typeof score === 'number' ? score : 0],
        ),
      ),
    };
  }

  async createResponse(systemPrompt: string, userPrompt: string): Promise<string> {
    try {
      const response = await this.client.responses.create({
        model: 'gpt-4o',
        input: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      } as any);

      if ((response as any).status !== 'completed') {
        throw new InternalServerErrorException('Something went wrong. Failed to complete task');
      }

      return (response as any).output_text ?? '';
    } catch (error) {
      this.logger.error(`OpenAI createResponse failed: ${(error as Error).message}`);
      throw new InternalServerErrorException('Something went wrong. Failed to process AI response');
    }
  }
}
