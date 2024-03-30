
import { hc } from 'hono/client'

// client.ts
const client = hc('http://localhost:3000')
const socket = client.ws.$ws();
socket.onopen = (w) => {
    socket.send("hello");
}
socket.onmessage = (ev) => {
    console.log(`from server: ${ev.data}`)
}
