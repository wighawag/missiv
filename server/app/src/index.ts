import { Context, Hono } from 'hono'
import { WSEvents } from 'hono/ws';

export function createServer(): Hono {
  const app = new Hono()

  app.get('/', (c) => {
    return c.text('Hello dd!')
  })

  return app;
}


export function handleWebsocket(c: Context) : WSEvents | Promise<WSEvents> {
  return {
    onMessage(event, ws) {
      console.log(`Message from client: ${event.data}`)
      ws.send('Hello from server!')
    },
    onClose: () => {
      console.log('Connection closed')
    },
  }
}
