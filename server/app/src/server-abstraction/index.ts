export abstract class AbstractServerObject {
	abstract upgradeWebsocket(request: Request): Promise<Response>;
	abstract getWebSockets(): WebSocket[];
	async fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
		return new Response('not implemented');
	}
	webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> | void {}
	webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> | void {}
}
