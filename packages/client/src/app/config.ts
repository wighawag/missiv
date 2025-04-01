import { PUBLIC_MISSIV_HTTP_ENDPOINT } from '$env/static/public';

let MISSIV_DOMAIN = 'localhost:5173';
if (typeof window != 'undefined') {
	MISSIV_DOMAIN = window.location.host;
}

const PUBLIC_MISSIV_WEBOSCKET_ENDPOINT = PUBLIC_MISSIV_HTTP_ENDPOINT.replace('http', 'ws');

export { PUBLIC_MISSIV_HTTP_ENDPOINT, MISSIV_DOMAIN, PUBLIC_MISSIV_WEBOSCKET_ENDPOINT };
