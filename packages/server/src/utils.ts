// `handleErrors()` is a little utility function that can wrap an HTTP request handler in a
// try/catch and return errors to the client. You probably wouldn't want to use this in production

import { CorsResponse } from './cors';

// code but it is convenient when debugging and iterating.
export async function handleErrors(request: Request, func: () => Promise<Response>): Promise<Response> {
	try {
		return await func();
	} catch (err: any) {
		if (request.headers.get('Upgrade') == 'websocket') {
			// Annoyingly, if we return an HTTP error in response to a WebSocket request, Chrome devtools
			// won't show us the response body! So... let's send a WebSocket response with an error
			// frame instead.
			let pair = new WebSocketPair();
			pair[1].accept();
			pair[1].send(JSON.stringify({ error: err.stack }, null, 2));
			pair[1].close(1011, 'Uncaught exception during session setup');
			return new CorsResponse(null, { status: 101, webSocket: pair[0] });
		} else {
			return new CorsResponse(JSON.stringify({ stack: err.stack }), { status: 500 });
		}
	}
}

export async function toJSONResponse(object: object | Promise<object>): Promise<Response> {
	object = await Promise.resolve(object);
	console.log(object);
	return new CorsResponse(JSON.stringify(object, null, 2));
}
