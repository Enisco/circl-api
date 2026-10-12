import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MESSAGE_SAFETY_QUEUE, MessageSafetyJob } from './message-safety.queue';
import { MessageSafetyService } from './message-safety.service';

/** The private-message scan (§6.8). Never changes what a member sees. */
@Injectable()
@Processor(MESSAGE_SAFETY_QUEUE)
export class MessageSafetyProcessor extends WorkerHost {
  private readonly logger = new Logger(MessageSafetyProcessor.name);

  constructor(private readonly safety: MessageSafetyService) {
    super();
  }

  async process(job: Job<MessageSafetyJob>): Promise<void> {
    try {
      await this.safety.scan(job.data.messageId);
    } catch (error) {
      this.logger.error(
        `Scan of message ${job.data.messageId} failed: ${(error as Error).message}`,
      );

      throw error;
    }
  }
}
