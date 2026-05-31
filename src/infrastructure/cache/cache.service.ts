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

  async delete(...keys: string[]): Promise<void> {
    for (const key of keys) {
      await this.redis.del(key);
    }
  }
}
