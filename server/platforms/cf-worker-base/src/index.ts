import { createServer, handleWebsocket } from 'missiv-server-app'
import { upgradeWebSocket } from 'hono/cloudflare-workers'

const app = createServer()

app.get(
  '/ws',
  upgradeWebSocket(handleWebsocket));


export default app
