---
title: cf-worker's send token bucket is still per isolate
slug: 2026-11-27-cf-send-bucket-still-per-isolate
date: 2026-11-27
---

Seen while building `cloudflare-durable-object-stores`: `account-rate-limits` anticipated that this task would move the send's token bucket (`${domain}:${account}`) into the Inbox Durable Object (`TokenBuckets.take` may return a promise for it), but the task's own scope did not include it and it was not done: on Cloudflare each isolate still has its own budget per account (`platforms/cf-worker/src/worker.ts`, `createInProcessTokenBuckets` by default). Moving it costs one more call to the Inbox object before every send's append, a latency trade-off worth its own task.
