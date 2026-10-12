import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

/** §6.8 names it. */
export const MESSAGE_SAFETY_QUEUE = 'message-safety';

export interface MessageSafetyJob {
  messageId: string;
}

@Injectable()
export class MessageSafetyQueue {
  private readonly logger = new Logger(MessageSafetyQueue.name);

  constructor(@InjectQueue(MESSAGE_SAFETY_QUEUE) private readonly queue: Queue<MessageSafetyJob>) {}

  /**
   * Queued **after** the message is committed, and never inside the write (§6.8: "never before,
   * never blocking").
   *
   * The opposite ordering from content, and for the opposite reason: content can be held, so its
   * verdict has to land in the same transaction as the row. A message is never held — delivery
   * does not wait for a scanner, and a slow OpenAI must not slow a conversation down. So the
   * worst case here is a message that is delivered and not scanned, which is logged loudly rather
   * than retried into the sender's request.
   */
  async enqueue(messageId: string): Promise<void> {
    try {
      await this.queue.add(
        'scan',
        { messageId },
        {
          // No colon: BullMQ reserves `:` for its own key shapes and rejects this id outright.
          jobId: `message-${messageId}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    } catch (error) {
      this.logger.error(
        `Could not queue a scan for message ${messageId}: ${(error as Error).message}`,
      );
    }
  }
}
