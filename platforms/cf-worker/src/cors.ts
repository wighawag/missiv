const corsHeaders: { [name: string]: string } = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type,SIGNATURE',
	'Access-Control-Max-Age': '86400',
};

export function handleOptions(request: Request) {
	if (
		request.headers.get('Origin') !== null &&
		request.headers.get('Access-Control-Request-Method') !== null &&
		request.headers.get('Access-Control-Request-Headers') !== null
	) {
		// Handle CORS pre-flight request.
		return new Response(null, {
			headers: corsHeaders,
		});
	} else {
		// Handle standard OPTIONS request.
		return new Response(null, {
			headers: {
				Allow: 'GET, HEAD, POST, OPTIONS',
			},
		});
	}
}

export class CorsResponse extends Response {
	constructor(body?: BodyInit | null, init?: ResponseInit) {
		if (init) {
			if (init.headers) {
				if (init.headers instanceof Headers) {
					for (const h of Object.keys(corsHeaders)) {
						init.headers.set(h, corsHeaders[h]);
					}
				} else {
					init.headers = {
						...init.headers,
						...corsHeaders,
					};
				}
			} else {
				init.headers = { ...corsHeaders };
			}
		} else {
			init = {
				headers: {
					...corsHeaders,
				},
			};
		}

		super(body, init);
	}
}
