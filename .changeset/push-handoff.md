---
'@missiv/common': minor
'@missiv/server': minor
---

A direct message's push is a documented contract, and its `navigate` carries the conversation for browsers where the app's service worker never runs (Safari 18.4+). `@missiv/common` exports `MissivPushData` (now with the `recipient` the push is for) and `MissivPushHandoff` with their readers, and the generic hand-off helpers `withPushHandoff`, `splitPushHandoff` and `consumePushHandoff`. The push's `navigate` stays the app's root and gains a `#push-handoff=<base64url JSON>` fragment, `{missiv: {type, namespace, conversationID, recipient}}`. The page reads it with `consumePushHandoff()`, which also removes it from the URL. See the README's "Push notifications".
