import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { Injectable } from '@nestjs/common';

@Injectable()
export class CacheService {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  async set<T>(key: string, value: T, ttl?: number): Promise<'OK' | null> {
    if (!ttl) {
      return await this.redis.set(key, JSON.stringify(value));
    }
    const serialized = JSON.stringify(value);

    return await this.redis.set(key, serialized, 'EX', ttl);
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await this.redis.get(key);

    return value ? (JSON.parse(value) as T) : null;
  }

  async getOrSet<T>(key: string, fn: () => Promise<T>, ttl?: number): Promise<T> {
    const value = await this.get<T>(key);

    if (value) return value;
    const result = await fn();

    await this.set(key, result, ttl);

    return result;
  }

  /**
   * Writes only if the key is absent, and says whether it won. The building block for a lock:
   * `getOrSet` cannot do this, because it reads and then writes, and two callers can both read
   * nothing.
   */
  async setIfAbsent<T>(key: string, value: T, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(key, JSON.stringify(value), 'PX', ttlMs, 'NX');

    return result === 'OK';
  }

  /** Remaining time to live in seconds, or null when the key is absent or has no expiry. */
  async ttl(key: string): Promise<number | null> {
    const seconds = await this.redis.ttl(key);

    return seconds >= 0 ? seconds : null;
  }

  async delete(...keys: string[]): Promise<void> {
    for (const key of keys) {
      await this.redis.del(key);
    }
  }
}
