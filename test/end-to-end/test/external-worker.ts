import {MISSIV_URL} from './prool/pool';

export function connectToMissiv() {
	return {
		async fetch(req: Request | string, init?: RequestInit) {
			let request: Request | string;
			if (typeof req === 'string') {
				if (req.startsWith('http')) {
					request = req;
				} else {
					if (req.startsWith('/')) {
						request = `${MISSIV_URL}${req}`;
					} else {
						request = `${MISSIV_URL}${req}`;
					}
				}
			} else {
				request = req;
			}
			const response = await fetch(request, init);

			return response;
		},
	};
}
