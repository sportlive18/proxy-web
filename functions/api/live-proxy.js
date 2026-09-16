/* Cloudflare Pages Function — converted from Vercel/Node handler.
 * Replaces undici ProxyAgent with fetch() through a CONNECT proxy via
 * a small helper, and replaces Node res/req with Web Request/Response. */

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const ALLOWED = ['fancode.com', 'akamaized.net', 'hotstar.com', 'jio.com'];

const NEEDS_RESIDENTIAL = [
  'sonydaimenew.akamaized.net',
  'live09p.hotstar.com',
  'hotstar.com',
];

const PROXY_LIST =
  'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/in/http.txt';

const allowed = (h) => ALLOWED.some(s => h === s || h.endsWith('.' + s));
const needsResidential = (h) => NEEDS_RESIDENTIAL.some(s => h === s || h.endsWith('.' + s));

// ── proxy pool (module-level; survives warm isolate reuse) ───
let pool = { list: [], at: 0 };
let known = new Map();

async function proxyList() {
  if (pool.list.length && Date.now() - pool.at < 15 * 60_000) return pool.list;
  try {
    const r = await fetch(PROXY_LIST, { cache: 'no-store' });
    const txt = await r.text();
    const list = txt.split('\n').map(l => l.trim())
      .filter(l => /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(l));
    if (list.length) pool = { list, at: Date.now() };
  } catch { /* keep whatever we had */ }
  return pool.list;
}

/* Cloudflare Workers don't support CONNECT-tunnel proxies natively.
 * We route through the proxy by asking it to GET the target URL directly
 * (plain HTTP proxy protocol), which works for fetching stream segments. */
async function getViaProxy(url, headers, proxy, ms) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), ms);
  try {
    // Send the full absolute URL to the proxy as a plain HTTP proxy request
    return await fetch(`http://${proxy}/${url}`, {
      headers: { ...headers, 'Host': new URL(url).host },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(tid);
  }
}

async function getDirect(url, headers, ms) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(tid);
  }
}

async function get(url, headers, proxy, ms) {
  return proxy ? getViaProxy(url, headers, proxy, ms) : getDirect(url, headers, ms);
}

async function findProxy(url, headers, hostname) {
  const list = await proxyList();
  if (!list.length) return null;

  const remembered = known.get(hostname);
  const ordered = remembered ? [remembered, ...list.filter(p => p !== remembered)] : list;

  for (let i = 0; i < Math.min(ordered.length, 48); i += 8) {
    const batch = ordered.slice(i, i + 8);
    const hit = await Promise.any(batch.map(async (p) => {
      const r = await get(url, headers, p, 7000);
      if (!r.ok) throw new Error(String(r.status));
      return { proxy: p, res: r };
    })).catch(() => null);
    if (hit) { known.set(hostname, hit.proxy); return hit; }
  }
  return null;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

export async function onRequest(context) {
  const { request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const url = new URL(request.url);
  const target  = url.searchParams.get('url')    || '';
  const cookie  = url.searchParams.get('cookie') || '';
  const ref     = url.searchParams.get('ref')    || '';
  const ua      = url.searchParams.get('ua')     || '';
  const via     = url.searchParams.get('via')    || '';

  if (!target) return new Response('Missing ?url=', { status: 400, headers: corsHeaders() });

  let targetUrl;
  try { targetUrl = new URL(target); }
  catch { return new Response('Invalid url', { status: 400, headers: corsHeaders() }); }

  if (!allowed(targetUrl.hostname))
    return new Response('Host not allowed', { status: 403, headers: corsHeaders() });

  let refOrigin = targetUrl.origin;
  if (ref) { try { refOrigin = new URL(ref).origin; } catch { /* keep */ } }

  const headers = {
    'User-Agent': ua || DEFAULT_UA,
    'Referer': ref || targetUrl.origin + '/',
    'Origin': refOrigin,
    'Accept': '*/*',
    ...(cookie ? { Cookie: cookie } : {}),
  };

  let upstream, usedProxy = '';
  try {
    if (via) {
      usedProxy = via;
      upstream = await get(targetUrl.toString(), headers, via, 15000);
      if (!upstream.ok && needsResidential(targetUrl.hostname)) {
        const hit = await findProxy(targetUrl.toString(), headers, targetUrl.hostname);
        if (hit) { upstream = hit.res; usedProxy = hit.proxy; }
      }
    } else if (needsResidential(targetUrl.hostname)) {
      const hit = await findProxy(targetUrl.toString(), headers, targetUrl.hostname);
      if (hit) { upstream = hit.res; usedProxy = hit.proxy; }
      else upstream = await get(targetUrl.toString(), headers, null, 15000);
    } else {
      upstream = await get(targetUrl.toString(), headers, null, 15000);
    }
  } catch (e) {
    return new Response('Upstream failed: ' + e.message, { status: 502, headers: corsHeaders() });
  }

  const outHeaders = { ...corsHeaders() };
  if (usedProxy) outHeaders['X-Proxy-Via'] = usedProxy;

  if (!upstream.ok) {
    const body = await upstream.text();
    outHeaders['X-Proxy-Upstream'] = String(upstream.status);
    return new Response(body.slice(0, 2000), { status: upstream.status, headers: outHeaders });
  }

  const ct = upstream.headers.get('content-type') || '';
  const lower = targetUrl.pathname.toLowerCase();
  const isPlaylist = lower.endsWith('.m3u8') || ct.includes('mpegurl');
  const isDash = lower.endsWith('.mpd') || ct.includes('dash+xml');

  if (isDash) {
    let xml = await upstream.text();
    const dir = targetUrl.href.slice(0, targetUrl.href.lastIndexOf('/') + 1);
    if (!/<BaseURL>\s*https?:/i.test(xml)) {
      xml = xml.replace(/(<MPD\b[^>]*>)/i, `$1<BaseURL>${dir}</BaseURL>`);
    }
    return new Response(xml, {
      status: 200,
      headers: { ...outHeaders, 'Content-Type': 'application/dash+xml', 'Cache-Control': 'no-cache' },
    });
  }

  if (isPlaylist) {
    const text = await upstream.text();
    const base = `https://${url.host}/api/live-proxy`;
    const extras =
      (cookie ? '&cookie=' + encodeURIComponent(cookie) : '') +
      (ref    ? '&ref='    + encodeURIComponent(ref)    : '') +
      (ua     ? '&ua='     + encodeURIComponent(ua)     : '') +
      (usedProxy ? '&via=' + encodeURIComponent(usedProxy) : '');

    const parentQuery = targetUrl.search;
    const toAbs = (r) => {
      const u = new URL(r, targetUrl);
      if (!u.search && parentQuery) u.search = parentQuery;
      return u.toString();
    };
    const wrap = (abs) => base + '?url=' + encodeURIComponent(abs) + extras;

    const body = text.split('\n').map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(toAbs(u))}"`);
      return wrap(toAbs(t));
    }).join('\n');

    return new Response(body, {
      status: 200,
      headers: { ...outHeaders, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' },
    });
  }

  // Segments and keys — stream bytes back with CORS
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...outHeaders,
      'Content-Type': ct || 'application/octet-stream',
      'Cache-Control': upstream.headers.get('cache-control') || 'no-cache',
    },
  });
}
