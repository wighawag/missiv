import {createServer, handleWebsocket} from 'missiv-server-app';
import { createBunWebSocket } from 'hono/bun'

const { upgradeWebSocket, websocket } = createBunWebSocket()

const app = createServer();

app.get(
    '/ws',
    upgradeWebSocket(handleWebsocket)
)

Bun.serve({
    fetch: app.fetch,
    websocket,
  })
