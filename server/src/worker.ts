import type { Env } from './env';
import { handleErrors } from './utils';
import { handleComversationsApiRequest } from './api';

//@ts-ignore
import INDEX_HTML from './index.html';
import { CorsResponse, handleOptions } from './cors';
import { handleRoomsApiRequest } from './ChatRoom/api';

export { ChatRoom, RateLimiter } from './ChatRoom';

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (request.method === 'OPTIONS') {
			return handleOptions(request);
		}
		return await handleErrors(request, async () => {
			let url = new URL(request.url);
			let path = url.pathname.slice(1).split('/');

			if (!path[0]) {
				// Serve our HTML at the root path.
				return new CorsResponse(INDEX_HTML, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
			}

			switch (path[0]) {
				case 'api':
					if (path.length > 1) {
						switch (path[1]) {
							case 'rooms':
								return handleRoomsApiRequest(path.slice(2), request, env);
							default:
								return new CorsResponse('Not found', { status: 404 });
						}
					} else {
						return handleComversationsApiRequest(path.slice(2), request, env);
					}

				default:
					return new CorsResponse('Not found', { status: 404 });
			}
		});
	},
};
