import {hc} from 'hono/client';
import {createServer} from 'missiv-server-app';

const args = process.argv.slice(2);
const endpoint = args[0] || 'http://127.0.0.1:8787';

// client.ts
const client = hc<ReturnType<typeof createServer>>(endpoint);

const socket = client.room[':name'].websocket.$ws({
	param: {
		name: 'hello',
	},
});

// global room
// const socket = new WebSocket(`${endpoint.replace('http://', 'ws://')}/websocket`);

// globlal web socket
// const socket = client.ws.$ws();
socket.onopen = (w) => {
	console.log(`socket is open`);
	socket.send('hello');
};
socket.onmessage = (ev) => {
	console.log(`from server: ${ev.data}`);
};

// const socket = new WebSocket('ws://127.0.0.1:8787/websocket');

// socket.addEventListener('message', (event) => {
// 	console.log(event.data);
// });
// socket.addEventListener('open', (event) => {
// 	console.log(event);
// });

// socket.addEventListener('error', (event) => {
// 	console.error(event);
// });
