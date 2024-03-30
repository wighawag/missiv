import { Context, Hono } from 'hono'

export function createServer(): Hono {
  const app = new Hono()

  app.get('/', (c) => {
    return c.text('Hello dddddddd!')
  })

  return app;
}

// export function handleWebsocket(func: (context: Context) => Promise<Res)

// (c) => {
//   return {
//     onMessage(event, ws) {
//       console.log(`Message from client: ${event.data}`)
//       ws.send('Hello from server!')
//     },
//     onClose: () => {
//       console.log('Connection closed')
//     },
//   }
// }