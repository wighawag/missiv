import type { Env } from './env';
import { handleErrors } from './utils';
import { handleApiRequest } from './api';

//@ts-ignore
import INDEX_HTML from './index.html';
import { CorsResponse, handleOptions } from './cors';

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
					return handleApiRequest(path.slice(1), request, env);
				default:
					return new CorsResponse('Not found', { status: 404 });
			}
		});
	},
};
