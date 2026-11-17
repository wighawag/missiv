---
'missiv-client': patch
'missiv-server': patch
'missiv-server-nodejs': patch
'missiv-server-bun': patch
'missiv-server-cf-worker': patch
---

The docs describe missiv 0.4 as built: CONTEXT.md's vocabulary (delegate key, ownership proof, domain user, request signature, copy signature, introduction, block, push) and its untrusted relay as it now holds, `docs/architecture.md` (the packages, the configuration: `ADMIN_TOKEN`, `SERVER_ORIGIN`, `PUSH_SERVER_URL`, `PUSH_TOKENS`, `EXPOSE_ERRORS`, `CHAIN_<id>`, `DB`; `createNodeServer`, `createInProcessRooms`, the migrations), ADR-0003 for the trust model and its known limits, and a README for missiv-client and each platform. The review's observations are discharged (their fixes landed), two new ones record what is still open (bun and cf-worker not run since the rework; the room rate limiter refusing a quick burst), and the backlog tasks `per-message-signature-over-ciphertext` and `frontend-send-message-error-handling` are cancelled as superseded by the S3c items that built them.
