---
'@missiv/common': minor
'@missiv/server': minor
'missiv': minor
'@missiv/bun': minor
---

Rate limits on direct messaging (spec `scalable-direct-messaging`, story 27): a token bucket per account (and domain) on `messages/send`, and one per client IP on `/api/session` and `register` together, refused `rate_limited` (429) with `details.retryAfterMs` and a `Retry-After` header.

- `@missiv/server`: `createTokenBuckets`, `createInProcessTokenBuckets`, `tokenBucketConfigsFromEnv`, `DEFAULT_TOKEN_BUCKETS`, `limitPerIP`, `charge`; the env `RATE_LIMIT_SEND_BURST` / `RATE_LIMIT_SEND_REFILL_PER_SECOND` (default 20, 1 a second) and `RATE_LIMIT_IP_BURST` / `RATE_LIMIT_IP_REFILL_PER_SECOND` (default 30, 0.5 a second); `ServerOptions.getTokenBuckets` (by default in process, idle buckets evicted). Breaking: `ServerOptions.inProcessRooms.getIP` moved to `ServerOptions.getIP`, which the per-IP limit and the rooms both use. `createInProcessRooms` evicts an idle room rate limiter (its map grew forever) and exposes `rateLimiterCount()`.
- `@missiv/common`: `RateLimitedDetails`.
- `missiv`, `@missiv/bun`: pass the client's IP as `getIP`. The cf-worker passes `CF-Connecting-IP`; its buckets are per isolate until the Inbox Durable Object holds them.
