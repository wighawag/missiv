---
title: A direct message's push data as a typed contract, and a hand-off in its navigate URL for browsers that never run the service worker
slug: push-data-contract-and-hash-handoff
blockedBy: []
covers: []
---

## Why

From the former idea note `a-dm-push-leads-to-its-conversation` (removed in b7c902a, which added this task; everything needed is here) (jolly-roger `with/messaging` QA, finding F19: clicking a direct message's notification opens the app's home page, not the conversation). Decided with the human (2026-11-25, 2026-11-26): missiv never puts an app route in `navigate`; it stays the app's root, and the app routes from the ids missiv sends.

Two facts shape the rest (checked 2026-11-26 against primary sources):

- The Notifications standard's activate steps (whatwg/notifications `notifications.bs`, "Activating a notification"): a notification with a navigation URL (`navigate`) is navigated to, and `notificationclick` is NOT fired. Only a notification without one reaches the app's click handler.
- WebKit's "Meet Declarative Web Push" and the Push API draft: on Safari 18.4+ (iOS/iPadOS Home Screen web apps) and 18.5+ (macOS), a `web_push: 8030` message is shown and clicked with no JavaScript; the service worker gets a `push` event only with `mutable: true`, which missiv does not set. So there the app's worker never sees missiv's push, `data` never reaches the page, and the click lands on `navigate`.

So the conversation must also travel in `navigate` itself, as a fragment of the root. Decided with the human (2026-11-26): missiv does it itself (push-notification-server forwards `navigate` as sent, so nothing is needed there), always, with no opt-in: an app that does not read the fragment just opens its root as before. The format is generic rather than missiv-specific, so another service pushing to the same app can use it too and the app keeps one reader; if several services ever do, the convention could move into push-notification-server unchanged.

## What to build

### 1. `data.missiv` as an exported, pinned type

- In `@missiv/common`: export `MissivPushData` (`type: 'message'`, `domain`, `namespace`, `conversationID`, `messageID`, `sender`) and a guard `readMissivPushData(data: unknown): MissivPushData | undefined` that an app's service worker calls on the notification's `data.missiv` without trusting its shape. A zod schema beside the others is the natural form.
- `pushMessage` (`packages/server/src/push.ts`) builds `data.missiv` as a `MissivPushData`.
- Versioning rule, written next to the type: adding a field is compatible; renaming, removing or changing one's meaning is a new `type` value. So both readers (`readMissivPushData`, `readMissivPushHandoff`) accept and ignore unknown fields (no `.strict()`), require `type: 'message'` (any other `type` gives `undefined`), and require each listed field to be a string. `MissivPushHandoff.type` is the same `'message'`.

### 2. The hand-off in `navigate`

- `navigate` becomes `${appOrigin || https://domain}/#push-handoff=<base64url JSON>`, the JSON being `{missiv: MissivPushHandoff}`. base64url without padding, of the UTF-8 JSON (a fixed 4/3 growth, where percent-encoded JSON can triple), encoded with `TextEncoder`/`TextDecoder` and `btoa`/`atob`, never `Buffer` (common runs in browsers, service workers and Workers). The JSON's key order is fixed, `{"missiv":{"type":...,"namespace":...,"conversationID":...}}`, so the test vector is stable. Keyed by service name so other services' hand-offs could sit beside it under the same convention.
- The convention combines with a fragment the URL already has (decided with the human, 2026-11-26): the hand-off is always the LAST segment, `#push-handoff=...` when the URL has no fragment, `#<existing fragment>&push-handoff=...` when it has one. base64url contains no `&` or `#`, so the segment's end is the end of the URL and it is found and removed exactly, leaving the existing fragment byte for byte. Precisely: a hash is in `location.hash` form (a leading `#`, or `''`); the hand-off is the text after the last `&` (or after the `#` when there is no `&`) if it starts with `push-handoff=`, and otherwise there is none; the remaining hash keeps its leading `#`, or is `''` when nothing is left. `withPushHandoff` treats an empty fragment (a URL ending in `#`) as none. missiv's own `navigate` is the root, so it never has one; the rule is for the generic helper and any other service using it.
- `MissivPushHandoff` (exported from `@missiv/common`) is only what routing needs: `type`, `namespace`, `conversationID`. Not `sender` or `messageID`: the URL ends up in the browser's history and in a link a user can copy, so it carries references, the fewest that route, never content; the page fetches the rest by id.
- In `@missiv/common`, all generic (nothing missiv-specific but the last one):
  - `withPushHandoff(url: string, handoff: object): string`: the URL with the segment appended by the rule above (what `pushMessage` calls).
  - `splitPushHandoff(hash: string): {handoff: Record<string, unknown> | undefined; hash: string}`: pure; the hand-off (absent, malformed or non-object gives `undefined`, never throws) and the hash WITHOUT the segment (`''` when nothing else was there).
  - `consumePushHandoff(location = window.location, history = window.history): Record<string, unknown> | undefined`, its parameters typed structurally (`{pathname: string; search: string; hash: string}` and `{state: unknown; replaceState(state: unknown, unused: string, url: string): void}`) so fakes type-check, with no top-level reference to `window` in the module (common also runs on servers); it calls `history.replaceState(history.state, '', pathname + search + remainingHash)`. For the page; reads the hand-off from the current URL and, when one was there, REMOVES it at once with `history.replaceState` (keeping path, query, `history.state` and the rest of the fragment), then returns it. Removing is part of reading, not left to the app: a hand-off left in the URL replays on reload, on a bookmark and in a link the user shares, and sits in the address bar. An app calls it on load BEFORE its router reads the URL (so a hash router only ever sees its own fragment) and on `hashchange` (`replaceState` itself fires no `hashchange`). It returns the whole hand-off; the app passes its `.missiv` to `readMissivPushHandoff`.
  - `readMissivPushHandoff(value: unknown): MissivPushHandoff | undefined` for the `missiv` key.
- Size: the whole message stays well under Web Push's payload limit (4096 bytes of record per RFC 8030/8291, about 3993 of plaintext). missiv's fields are bounded by their schemas in `@missiv/common` (`domain` 253, `namespace` 64, `conversationID` 256, `appOrigin` 300; worst case about 1.95 KB with ASCII values; in practice `conversationID` is at most 84 characters, since the server requires it to equal `conversationIDOf` the members), so a test asserts the serialized message's size under a stated margin, rather than a check at run time. The schema limits count UTF-16 code units, not bytes, so the test covers both: ASCII strings at each schema maximum, and separately a 64-character namespace that JSON escapes as `\uXXXX`.

### 3. Docs

A "Push notifications" section in the root README (or `packages/server/README.md`, linked from the root): what a push contains and never contains (no message content), `navigate` (the root plus the hand-off fragment), `tag` (one notification per conversation), `data.missiv`, the hand-off's format and readers, and how an app reaches the conversation: from its service worker's `notificationclick` where the worker runs (showing the notification WITHOUT `navigate`, or the click never reaches it, per the standard above), and from the fragment on load where it does not (Safari 18.4+), with the sources. One line on the trade-off of no opt-in: an app that routes on the URL fragment must call `consumePushHandoff` before its router starts, or the router sees `#push-handoff=...` at the root, and must register its `hashchange` listener before the router's (or in the capture phase on `window`). The section also prints the test vector (input URL, hand-off, expected output) so another implementation can check itself against it.

### Out of scope

- Any app route in `navigate`.
- An opt-in for the hand-off (decided: none).
- `mutable: true`: it gives up Declarative Web Push's reliability and only helps an app whose worker re-shows the notification.
- Any change to push-notification-server.

## Acceptance criteria

- [x] `MissivPushData`, `MissivPushHandoff`, `withPushHandoff`, `splitPushHandoff`, `consumePushHandoff`, `readMissivPushData` and `readMissivPushHandoff` are exported from `@missiv/common`; `pushMessage` builds `data.missiv` and the fragment through them.
- [x] `push.test.ts` pins the whole message: `web_push`, `title`, `body` (sender abbreviated, no content), `navigate` exactly the root plus `#push-handoff=` and the expected encoding of `{missiv: {type, namespace, conversationID}}`, `tag`, `data.missiv` field by field.
- [x] The hand-off helpers' tests live in `packages/server/src/push-handoff.test.ts`, importing from `@missiv/common` (common has no test runner, and the root `pnpm test` runs only packages with a `test` script; do not add one to common for this).
- [x] `splitPushHandoff` round-trips `withPushHandoff` (a fixed test vector, so another implementation can check itself against it), for a URL without a fragment and with one (`#/conversations?x=1` comes back byte for byte); the readers return `undefined` for a missing, malformed or wrong-type value, and accept a value with an extra unknown field.
- [x] `consumePushHandoff` (tested on a fake location and history) removes the segment with `replaceState`, keeps path, query, state and the rest of the fragment, returns the hand-off once, and does nothing (no `replaceState`) when there is none.
- [x] A test asserts the serialized message (its UTF-8 bytes) stays under 3500 bytes, both with ASCII `domain`, `namespace`, `conversationID` and `appOrigin` at their schema maximums and with a 64-character namespace that JSON escapes as `\uXXXX` (3993 bytes of plaintext, minus a margin).
- [x] The README section exists, with the browser behaviour, its sources, and the no-opt-in trade-off.
- [x] A changeset for `@missiv/common` and `@missiv/server` (minor: new exports; `navigate` gains a fragment, its path unchanged).
- [x] `pnpm -r format:check && pnpm build && pnpm test` is green.

## Decisions

- The hand-off also carries `recipient`, by the human's decision after the task was written (2026-11-27), and so does `data.missiv`: a device can be registered for several accounts, so the app checks the push's account against the one it is connected as and tells the user when they differ. It costs no privacy: a two-member `conversationID` is already both addresses concatenated (`getConversationID`), so the URL held them anyway. `sender` stays out, as routing does not need it.
- `consumePushHandoff` also removes a malformed hand-off from the URL (returning `undefined`), rather than leaving garbage in the address bar.
- `MissivPushData.sender` and `recipient` are typed `string`, not `Address`: the readers check strings only, so a stricter type would claim what they do not verify.
- Measured: 2,082 bytes for a push with every field at its schema maximum, 2,829 with a JSON-escaped namespace (the test asserts under 3,500).

## Prompt

Make the push missiv sends for a new direct message a typed, documented contract, and carry the conversation in its `navigate` URL as a `#push-handoff=<base64url JSON>` fragment of the app's root, always, for browsers that never run the service worker. Read this task's "Why" first. Before building, check its premises against the current code (`pushMessage`'s shape, the schema limits in `@missiv/common`, `conversationIDOf`); if one no longer holds, stop and surface it rather than build. Work in `packages/server/src/push.ts` (`pushMessage`), `packages/server/src/push.test.ts`, a new `packages/server/src/push-handoff.test.ts`, and `packages/common/src/index.ts` (where the zod schemas live). Never put an app route in `navigate`. The hand-off carries `type`, `namespace` and `conversationID` only, under the key `missiv`; it is always the last fragment segment, and reading it in the page removes it from the URL. Domain vocabulary is in `CONTEXT.md`. Add a changeset (`pnpm changeset`).
