import { NextResponse } from 'next/server';
export async function GET() {
	const isCloudflare = !!(process.env.CF_PAGES || process.env.CLOUDFLARE);
	const adminSecretConfigured =
		!!process.env.ADMIN_SECRET &&
		process.env.ADMIN_SECRET.trim().length > 0;
	return NextResponse.json({
		success: true,
		data: {
			isCloudflare,
			adminSecretConfigured,
		},
	});
}
