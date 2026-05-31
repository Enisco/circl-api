import { Module } from '@nestjs/common';
import { OpenAIProvider } from './openai.provider';

@Module({
  providers: [OpenAIProvider],
  exports: [OpenAIProvider],
})
export class AiModule {}
