---
title: A room refuses a message sent before the rate limiter answered the previous one, inside the burst grace
slug: room-rate-limiter-refuses-back-to-back-messages
date: 2026-11-17
---

# The rate limiter's grace does not apply to a quick burst

Seen in S3c (missiv `tf-S3/main`, `test/client-server/test/stores.test.ts`, "marks a refused message failed"): two room messages sent back to back are answered `rate_limited` for the second, although `RateLimiter` grants a 20 s grace "so the client can make 4-5 requests in a quick burst" (`packages/server/src/RateLimiter.ts`). `RateLimiterClient.checkLimit` sets `inCooldown` until the limiter's answer has come back and its cooldown (0 within the grace) has elapsed, so any message arriving while that round trip is in flight is refused, whatever the grace. A login counts as a message too, so a client that sends right after its login is refused once (S3b's surprise).

The client now shows such a message as `failed` with the room's error instead of dropping it, so nothing is lost silently; but the behaviour is stricter than the limiter documents.

## Suggested direction (not yet decided)

Let `checkLimit` accept while the last known cooldown is 0 and only refuse once the limiter has answered a positive cooldown, or not count the login.
