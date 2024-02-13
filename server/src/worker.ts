// With the introduction of modules, we're experimenting with allowing text/data blobs to be
// uploaded and exposed as synthetic modules. In wrangler.toml we specify a rule that files ending
// in .html should be uploaded as "Data", equivalent to content-type `application/octet-stream`.
// So when we import it as `HTML` here, we get the HTML content as an `ArrayBuffer`. This lets us
// serve our app's static asset without relying on any separate storage. (However, the space
// available for assets served this way is very limited; larger sites should continue to use Workers
// KV to serve assets.)

import {handleErrors} from './utils';

export interface Env {
	// Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
	// MY_KV_NAMESPACE: KVNamespace;


	//
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	// MY_BUCKET: R2Bucket;
	//
	// Example binding to a Service. Learn more at https://developers.cloudflare.com/workers/runtime-apis/service-bindings/
	// MY_SERVICE: Fetcher;
	//
	// Example binding to a Queue. Learn more at https://developers.cloudflare.com/queues/javascript-apis/
	// MY_QUEUE: Queue;
}


// In modules-syntax workers, we use `export default` to export our script's main event handlers.
// Here, we export one handler, `fetch`, for receiving HTTP requests. In pre-modules workers, the
// fetch handler was registered using `addEventHandler("fetch", event => { ... })`; this is just
// new syntax for essentially the same thing.
//
// `fetch` isn't the only handler. If your worker runs on a Cron schedule, it will receive calls
// to a handler named `scheduled`, which should be exported here in a similar way. We will be
// adding other handlers for other types of events over time.
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return await handleErrors(request, async () => {
      // We have received an HTTP request! Parse the URL and route the request.

      let url = new URL(request.url);
      let path = url.pathname.slice(1).split('/');

      if (!path[0]) {
        // Serve our HTML at the root path.
        return new Response("hh", {headers: {"Content-Type": "text/html;charset=UTF-8"}});
      }

      switch (path[0]) {
        case "api":
          // This is a request for `/api/...`, call the API handler.
          // return handleApiRequest(path.slice(1), request, env);
          return new Response("WIP api", {status: 404});

        default:
          return new Response("Not found", {status: 404});
      }
    });
  }
}


