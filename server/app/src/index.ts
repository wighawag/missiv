import { Hono } from 'hono'

export function createServer(): Hono {
  const app = new Hono()

  app.get('/', (c) => {
    return c.text('Hello dd!')
  })

  return app;
}
