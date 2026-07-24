---
'missiv-server': patch
---

Remove debug logging and fix a misleading schema comment.

- Stop logging authentication material: dropped the `console.log` that printed the WebSocket login signature and challenge, plus two other stray debug logs in `Room` and `RemoteSQLStorage.sendMessage`.
- Fix the inverted status comment in the ConversationParticipants schema so it matches the actual enum (`0 = unaccepted, 1 = rejected, 2 = accepted`).
