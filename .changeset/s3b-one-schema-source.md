---
'missiv-common': minor
'missiv-server': minor
'missiv-client': minor
---

One schema source and typed errors. The request schemas are zod schemas in missiv-common, with their types inferred from them; missiv-server validates against them (an invalid body is a 400 `invalid_request`). Every error answers `{error: {code, message, details?}}` under its code's status (400, 401, 403, 404, 409, 429, 500), and missiv-client's `API` throws a `MissivAPIError` carrying both. Removed: the unused Hono client export (`createClient`, `Client`), the `/api/public/ws` echo route and `/api/public/` (so a platform without WebSockets can build the app), CORS credentials, and dead code (`utils/response.ts`, `css2ts.cjs`, the Room's `requireLogin` and `DEBUG` branch, nodejs's `migrate.ts`). `ConversationMessage` now declares the `signature` the server returns.
