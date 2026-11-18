
import { ok, fail, handleError, readBody } from "@/lib/api";
import { getKV, getMusicCookie, KV_COOKIE_KEYS } from "@/lib/kv";
import { cookies } from "next/headers";

/**
 * POST /api/auth/music-cookie
 *
 * Save music platform cookies (NetEase/QQ) after QR login to both HTTP Cookie and Cloudflare KV
 * so the server can use them for VIP song playback / download.
 *
 * Body: { platform: "netease" | "qq", cookie: string }
 *
 * GET /api/auth/music-cookie?platform=netease
 * Returns the stored cookie for the specified platform (prioritizes HTTP Cookie, falls back to KV / Env).
 */
export async function POST(req: Request) {
  try {
    const body = await readBody<{ platform?: string; cookie?: string }>(req);
    const platform = (body.platform ?? "").trim();
    const cookie = (body.cookie ?? "").trim();
    if (!platform || !cookie) return fail("缺少 platform 或 cookie", 400);
    if (!["netease", "qq"].includes(platform)) return fail("不支持的平台", 400);

    // 1. 写入 HTTP Cookie
    const cookieName = `music_cookie_${platform}`;
    const store = await cookies();
    store.set(cookieName, cookie, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 30 * 24 * 60 * 60, // 30 days
    });

    // 2. 同步写入 Cloudflare KV
    try {
      const kv = await getKV();
      const kvKey = KV_COOKIE_KEYS[platform as "netease" | "qq"];
      await kv.put(kvKey, cookie);
    } catch (kvErr) {
      console.error(`Failed to save ${platform} cookie to KV:`, kvErr);
    }

    return ok({ saved: true, platform });
  } catch (err) {
    return handleError(err);
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const platform = url.searchParams.get("platform") ?? "";
    if (!["netease", "qq"].includes(platform)) return fail("不支持的平台", 400);

    // 1. 优先尝试获取当前请求中的 HTTP Cookie
    const cookieName = `music_cookie_${platform}`;
    const store = await cookies();
    let cookie = store.get(cookieName)?.value || null;

    // 2. 若 HTTP Cookie 不存在，则使用 getMusicCookie 尝试从 KV / 环境变量拉取
    if (!cookie) {
      cookie = await getMusicCookie(platform as "netease" | "qq");
    }

    return ok({ platform, cookie, hasCookie: !!cookie });
  } catch (err) {
    return handleError(err);
  }
}
