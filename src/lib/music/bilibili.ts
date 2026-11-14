/**
 * Bilibili (哔哩哔哩) platform plugin.
 *
 * WBI-signed search + buvid3-authenticated playurl.
 * Replaces the legacy search/type endpoint (which triggers 412) with the
 * official WBI-signed endpoint.
 */

import { createHash } from 'node:crypto'

const BILI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

interface SongInfo {
  id: number
  bvid: string
  title: string
  author: string
  pic: string
  duration: string
}

interface VideoPage {
  cid: number
  page: number
  part: string
  duration: number
}

interface VideoInfoRes {
  code: number
  message: string
  data: {
    pages: VideoPage[]
  }
}

interface SearchRes {
  code: number
  message: string
  data: {
    result: SongInfo[]
  }
}

interface CidRes {
  code: number
  message: string
  data: {
    pages: [{ cid: string }]
  }
}

interface NoRefererPlayUrlRes {
  code: number
  message: string
  data: {
    durl: [{ url: string }]
  }
}

export interface BilibiliTrack {
  id: string
  title: string
  artist: string
  source: 'bilibili'
  musicPlatform: 'bilibili'
  cover: string
  duration: number
  album: string
  pages: VideoPage[]
}

// ---------- buvid3 获取与缓存 ----------

interface SpiRes {
  code: number
  data: { b_3: string; b_4: string }
}

let cachedBuvid3: string | null = null

async function getBuvid3(): Promise<string> {
  if (cachedBuvid3) return cachedBuvid3

  const resp = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
    headers: { 'User-Agent': BILI_UA, Referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(8000)
  })
  if (!resp.ok) throw new Error(`获取 buvid3 失败: HTTP ${resp.status}`)

  const json = (await resp.json()) as SpiRes
  if (json.code !== 0 || !json.data?.b_3) {
    throw new Error('获取 buvid3 失败: 接口未返回 b_3')
  }

  // buvid3 需要 infoc 后缀才能通过强校验
  cachedBuvid3 = `${json.data.b_3}infoc;`
  return cachedBuvid3
}

// ---------- WBI 密钥获取与签名 ----------

interface NavRes {
  code: number
  data?: { wbi_img?: { img_url: string; sub_url: string } }
}

let cachedMixinKey: string | null = null
let cachedMixinKeyAt = 0
const MIXIN_KEY_TTL = 60 * 60 * 1000 // 1 小时；密钥每日轮换，1 小时缓存足够安全

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
]

function extractKey(url: string): string {
  const filename = url.split('/').pop() ?? ''
  return filename.split('.')[0] ?? ''
}

function buildMixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey
  return MIXIN_KEY_ENC_TAB.map((n) => raw[n] ?? '').join('').slice(0, 32)
}

async function getMixinKey(): Promise<string> {
  if (cachedMixinKey && Date.now() - cachedMixinKeyAt < MIXIN_KEY_TTL) {
    return cachedMixinKey
  }

  const resp = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { 'User-Agent': BILI_UA, Referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(8000)
  })
  if (!resp.ok) throw new Error(`获取 WBI 密钥失败: HTTP ${resp.status}`)

  const json = (await resp.json()) as NavRes
  const wbi = json.data?.wbi_img
  if (!wbi?.img_url || !wbi?.sub_url) {
    throw new Error('获取 WBI 密钥失败: nav 接口未返回 wbi_img')
  }

  cachedMixinKey = buildMixinKey(extractKey(wbi.img_url), extractKey(wbi.sub_url))
  cachedMixinKeyAt = Date.now()
  return cachedMixinKey
}

/**
 * WBI 编码：必须遵循 encodeURIComponent 规则，并将 !'()* 也转义。
 * 不可直接使用 URLSearchParams，否则空格会被编码为 + 而非 %20，导致签名错误。
 */
function encodeWbiValue(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

function signWbiParams(
  params: Record<string, string>,
  mixinKey: string
): Record<string, string> {
  const wts = String(Math.floor(Date.now() / 1000))
  const withWts = { ...params, wts }

  const sortedQuery = Object.keys(withWts)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeWbiValue(withWts[key])}`)
    .join('&')

  const wRid = createHash('md5').update(sortedQuery + mixinKey).digest('hex')
  return { ...withWts, w_rid: wRid }
}

// ---------- 工具函数 ----------

function htmlDecode(value: string) {
  return value.replace(/<[^>]*>/g, '')
}

function bi_convert_song(song_info: SongInfo, pages?: VideoPage[]): BilibiliTrack {
  let imgUrl = song_info.pic
  const durationStr = song_info.duration
    .split(':')
    .map((x) => Number.parseInt(x))
    .reverse()
  let duration = durationStr[0] + durationStr[1] * 60
  if (durationStr.length === 3) {
    duration += durationStr[2] * 60 * 60
  }
  if (imgUrl.startsWith('//')) {
    imgUrl = `https:${imgUrl}`
  }
  return {
    id: song_info.bvid,
    title: htmlDecode(song_info.title),
    artist: htmlDecode(song_info.author),
    source: 'bilibili',
    musicPlatform: 'bilibili',
    cover: imgUrl,
    duration,
    album: 'Bilibili Video',
    pages: pages || []
  }
}

// ---------- 搜索（WBI 签名版） ----------

export async function searchBilibili(keyword: string, limit = 15): Promise<BilibiliTrack[]> {
  if (!keyword) return []

  let buvid3: string
  let mixinKey: string
  try {
    ;[buvid3, mixinKey] = await Promise.all([getBuvid3(), getMixinKey()])
  } catch (error) {
    throw new Error(
      `B站搜索前置准备失败: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const rawParams: Record<string, string> = {
    __refresh__: 'true',
    page: '1',
    page_size: String(limit),
    platform: 'pc',
    highlight: '1',
    single_column: '0',
    keyword,
    search_type: 'video',
    dynamic_offset: '0',
    preload: 'true',
    com2co: 'true',
    web_location: '333.1368'
  }

  const signedParams = signWbiParams(rawParams, mixinKey)
  const query = new URLSearchParams(signedParams).toString()
  const targetUrl = `https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`

  const resp = await fetch(targetUrl, {
    method: 'GET',
    headers: {
      Cookie: `buvid3=${buvid3}`,
      Referer: 'https://search.bilibili.com/',
      'User-Agent': BILI_UA
    },
    signal: AbortSignal.timeout(12000)
  })

  if (!resp.ok) {
    if (resp.status === 412) {
      console.warn('[bilibili] 搜索触发 412 风控，返回空结果')
      return []
    }
    throw new Error(`B站搜索失败: HTTP ${resp.status}`)
  }

  const json = (await resp.json()) as SearchRes
  if (json.code !== 0 || !json.data?.result) {
    throw new Error(`B站搜索接口异常: ${json.message || `code=${json.code}`}`)
  }

  const results = await Promise.all(
    json.data.result.map(async (song) => {
      try {
        const viewUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(song.bvid)}`
        const viewRes = await fetch(viewUrl, {
          headers: {
            Cookie: `buvid3=${buvid3}`,
            'User-Agent': BILI_UA,
            Referer: 'https://www.bilibili.com/'
          },
          signal: AbortSignal.timeout(8000)
        })
        if (!viewRes.ok) return bi_convert_song(song)
        const videoInfo = (await viewRes.json()) as VideoInfoRes
        if (videoInfo.code !== 0) return bi_convert_song(song)
        return bi_convert_song(song, videoInfo.data?.pages || [])
      } catch {
        return bi_convert_song(song)
      }
    })
  )
  return results
}

// ---------- 播放地址解析（buvid3 认证版） ----------

export async function resolveBilibiliUrl(
  bvid: string,
  cid?: string | number,
  clientIp?: string
): Promise<{ url: string; pay: false }> {
  if (!bvid) throw new Error('缺少 id 参数')

  const buvid3 = await getBuvid3().catch(() => '') // 降级：仍可尝试无 buvid3 解析

  const headers: Record<string, string> = {
    Referer: 'https://www.bilibili.com/',
    'User-Agent': BILI_UA
  }
  if (buvid3) headers.Cookie = `buvid3=${buvid3}`
  if (clientIp) {
    headers['X-Forwarded-For'] = clientIp
    headers['X-Real-IP'] = clientIp
    headers['Client-IP'] = clientIp
  }

  let finalCid = cid ? String(cid) : ''

  if (!finalCid) {
    const viewUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`
    const resp1 = await fetch(viewUrl, {
      headers,
      signal: AbortSignal.timeout(8000)
    })
    if (!resp1.ok) throw new Error(`获取 B站视频信息失败: HTTP ${resp1.status}`)
    const viewJson = (await resp1.json()) as CidRes
    if (!viewJson?.data?.pages?.[0]?.cid) {
      throw new Error('获取 CID 失败')
    }
    finalCid = viewJson.data.pages[0].cid
  }

  // platform=html5 绕过严格防盗链，前端使用 referrerpolicy="no-referrer" 即可播放
  const playParams = new URLSearchParams({
    fnval: '1',
    platform: 'html5',
    high_quality: '1',
    bvid,
    cid: finalCid
  })
  const playUrl = `https://api.bilibili.com/x/player/playurl?${playParams.toString()}`

  const resp2 = await fetch(playUrl, {
    headers,
    signal: AbortSignal.timeout(10000)
  })
  if (!resp2.ok) throw new Error(`获取 B站播放链接失败: HTTP ${resp2.status}`)
  const playJson = (await resp2.json()) as NoRefererPlayUrlRes
  if (playJson.code !== 0 || !playJson.data?.durl?.length) {
    throw new Error(`获取歌曲链接失败: ${playJson.message || '未知错误'}`)
  }
  return { url: playJson.data.durl[0].url, pay: false }
}