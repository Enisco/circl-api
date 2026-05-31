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
