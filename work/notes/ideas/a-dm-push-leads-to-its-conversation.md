---
title: A direct message's push is routed by the app from its data, so missiv keeps navigate at the root and documents data.missiv
type: idea
status: incubating
created: 2026-11-25
slug: a-dm-push-leads-to-its-conversation
---

# A direct message's push is routed by the app, from `data.missiv`

## Seen

In the template tree's manual QA (jolly-roger `with/messaging`, 2026-11-25, finding F19 of `~/dev/qa/baseline-2026-11-24/findings.md`), clicking a direct message's notification opened the app's home page, not the conversation. `pushMessage` in `packages/server/src/push.ts` sets the Declarative Web Push `navigate` to the app ROOT (`${appOrigin || https://domain}/`) and puts the conversation in `data.missiv` (`type`, `domain`, `namespace`, `conversationID`, `messageID`, `sender`).

## Direction (decided with the human, 2026-11-25)

The ids are enough: the APP's service worker reads `data.missiv` on click and opens the conversation itself (the template's worker is being changed to hand a click to an open tab and let the app route in-page, F19). missiv should NOT put an app URL in `navigate`: that would tie missiv to each app's URL structure and make changing it harder. `navigate` stays at the app's root as the fallback.

## What that leaves for missiv

- Treat `data.missiv` as a public contract: document its fields and their meaning in the README (and keep them stable, or version them through `type`), since apps now route on them.
- A known limit, worth a line in the docs: a browser that handles Declarative Web Push natively, without running the app's service worker for the click, lands on `navigate` (the root); the app can then pick up the pending conversation on load only if it is told some other way. Not a reason to change `navigate`.
