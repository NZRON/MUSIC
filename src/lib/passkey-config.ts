const MULTI_LABEL_PUBLIC_SUFFIXES = [
	'github.io',
	'gitlab.io',
	'herokuapp.com',
	'pythonanywhere.com',
	'bubbleapps.io',
	'loca.lt',
	'nip.io',
	'sslip.io',
	'qzz.io',
];
function getRegistrableDomain(hostname: string): string {
	if (hostname === 'localhost') return hostname;
	if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return hostname;
	if (/^\[?[0-9a-f:]+\]?$/i.test(hostname)) return hostname;
	const parts = hostname.split('.');
	if (parts.length <= 2) return hostname;
	for (const suffix of MULTI_LABEL_PUBLIC_SUFFIXES) {
		const suffixParts = suffix.split('.');
		if (parts.length > suffixParts.length) {
			const tail = parts.slice(-suffixParts.length).join('.');
			if (tail === suffix) {
				return parts.slice(-suffixParts.length - 1).join('.');
			}
		}
	}
	return parts.slice(-2).join('.');
}
export function getRpId(req?: Request): string {
	if (req) {
		try {
			const host =
				req.headers.get('host') || req.headers.get('x-forwarded-host');
			if (host) {
				const hostname = host.split(':')[0];
				if (hostname) return getRegistrableDomain(hostname);
			}
		} catch {}
	}
	return 'localhost';
}
export function getRpOrigin(req?: Request): string {
	if (req) {
		try {
			const url = new URL(req.url);
			return `${url.protocol}//${url.host}`;
		} catch {}
	}
	return 'http://localhost:3000';
}
