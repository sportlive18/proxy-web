/* functions/api/live-proxy.js — Cloudflare Pages Function.
 *
 * Same tunnelfetch / cloudflare:sockets approach as the Worker version, so
 * SonyLiv CDN requests egress through an Indian residential proxy instead of
 * a Cloudflare datacenter IP.
 *
 * Public URL:
 *   /api/live-proxy?url=<encoded>[&cookie=][&ref=][&ua=][&via=host:port]
 *
 * Deployed under a Pages project, this runs on the same origin as the
 * front-end, so same-origin requests are allowed implicitly. Requests from
 * other origins are checked against ALLOWED_ORIGINS.
 */
import { Client } from 'tunnelfetch';
import { connect } from 'cloudflare:sockets';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* Extra front-ends allowed to call this function from a different origin.
 * Same-origin callers (the Pages host this function is deployed on) are
 * always allowed — see requestOrigin(). */
const ALLOWED_ORIGINS = [
  'https://sportlink10-ajp.pages.dev',
  'https://sportlink18-web.pages.dev',
];

const ALLOWED = [
  'cloudplay-sonyliv.pages.dev',
  'slivcdn.com',
  'dishmt.slivcdn.com',
  'akamaized.net',
  'sonydaimenew.akamaized.net',
];

const NEEDS_RESIDENTIAL = [
  'cloudplay-sonyliv.pages.dev',
  'slivcdn.com',
  'dishmt.slivcdn.com',
  'sonydaimenew.akamaized.net',
];

/* If you have a paid residential provider, set this as a Pages env var
   (Settings → Environment variables → PROXY_ENDPOINT). Format:
     host:port
   or
     user:pass@host:port
   When set, the free list is skipped entirely. */
const PROXY_LIST =
  'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/in/http.txt';

const MAX_POOL = 500;
const MAX_TRY = 24;
const BATCH = 4;
const PROXY_TIMEOUT_MS = 7000;
const UPSTREAM_TIMEOUT_MS = 15000;

const allowed = (h) => ALLOWED.some(s => h === s || h.endsWith('.' + s));
const needsResidential = (h) => NEEDS_RESIDENTIAL.some(s => h === s || h.endsWith('.' + s));

// ── origin guard ────────────────────────────────────────────
/* Same-origin (the Pages host this function runs on) is always allowed;
   that is where the front-end lives. Cross-origin callers must be in
   ALLOWED_ORIGINS. */
function requestOrigin(request) {
  const reqHost = new URL(request.url).host;
  const selfOrigins = [`https://${reqHost}`];

  const check = (value) => {
    if (!value) return null;
    try {
      const o = new URL(value).origin;
      if (selfOrigins.includes(o)) return o;
      return ALLOWED_ORIGINS.includes(o) ? o : null;
    } catch { return null; }
  };

  const origin = request.headers.get('Origin');
  if (origin) return check(origin);

  const referer = request.headers.get('Referer');
  if (referer) return check(referer);

  /* No Origin and no Referer. That happens for:
     - Safari's native HLS media element doing a cross-origin fetch
     - curl / Node clients
     - direct URL visits
     Same-origin <video> in Safari sends neither, so treat this as same-origin
     rather than reject. If you want to require a header, return null here. */
  return selfOrigins[0];
}

function corsHeaders(matchedOrigin) {
  return {
    'Access-Control-Allow-Origin': matchedOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'X-Proxy-Via, X-Proxy-Upstream, Content-Range, Accept-Ranges',
    'Vary': 'Origin',
  };
}

// ── proxy pool ──────────────────────────────────────────────
let pool = { list: [], at: 0 };
let known = new Map(); // hostname -> proxy that last worked for it

async function proxyList(env) {
  const paid = env?.PROXY_ENDPOINT || '';
  if (paid) return [paid];

  if (pool.list.length && Date.now() - pool.at < 15 * 60_000) return pool.list;
  try {
    const r = await fetch(PROXY_LIST, { cache: 'no-store' });
    const txt = await r.text();
    const list = txt.split('\n').map(l => l.trim())
      .filter(l => /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(l))
      .slice(0, MAX_POOL);
    if (list.length) pool = { list, at: Date.now() };
  } catch { /* keep whatever we had */ }
  return pool.list;
}

function proxiedFetch(proxyHostPort) {
  return new Client({
    connect,
    proxy: `http://${proxyHostPort}`,
  });
}

async function findProxy(url, headers, hostname, env) {
  const list = await proxyList(env);
  if (!list.length) return null;

  const remembered = known.get(hostname);
  const ordered = remembered ? [remembered, ...list.filter(p => p !== remembered)] : list;
  const cap = Math.min(ordered.length, MAX_TRY);

  for (let i = 0; i < cap; i += BATCH) {
    const batch = ordered.slice(i, Math.min(i + BATCH, cap));
    const hit = await Promise.any(batch.map(async (p) => {
      const client = proxiedFetch(p);
      const r = await client.fetch(url, {
        headers,
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(String(r.status));
      return { proxy: p, res: r };
    })).catch(() => null);
    if (hit) { known.set(hostname, hit.proxy); return hit; }
  }
  return null;
}

/* A 200 from a public proxy is not proof of a 200 from the origin. Verify
   playlist bodies actually start with #EXTM3U before rewriting them. */
async function fetchWithSanity(client, url, headers, expectPlaylist) {
  const r = await client.fetch(url, {
    headers,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!r.ok || !expectPlaylist) return r;
  const text = await r.text();
  if (!/^\s*#EXTM3U/.test(text)) {
    throw new Error('proxy returned non-HLS body');
  }
  return new Response(text, { status: r.status, headers: r.headers });
}

// ── handler ─────────────────────────────────────────────────
export async function onRequest(context) {
  const { request, env } = context;
  const reqUrl = new URL(request.url);
  const matchedOrigin = requestOrigin(request);

  if (request.method === 'OPTIONS') {
    if (!matchedOrigin) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders(matchedOrigin) });
  }

  if (!matchedOrigin) {
    return new Response('Forbidden: origin not allowed', {
      status: 403,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  const cors = corsHeaders(matchedOrigin);

  const target = reqUrl.searchParams.get('url');
  const cookie = reqUrl.searchParams.get('cookie') || '';
  const ref = reqUrl.searchParams.get('ref') || '';
  const ua = reqUrl.searchParams.get('ua') || '';
  const via = reqUrl.searchParams.get('via') || '';

  if (!target) return new Response('Missing ?url=', { status: 400, headers: cors });

  let targetUrl;
  try { targetUrl = new URL(target); } catch {
    return new Response('Invalid url', { status: 400, headers: cors });
  }
  if (!allowed(targetUrl.hostname)) {
    return new Response('Host not allowed', { status: 403, headers: cors });
  }

  let refOrigin = targetUrl.origin;
  if (ref) { try { refOrigin = new URL(ref).origin; } catch { /* keep */ } }

  const headers = {
    'User-Agent': ua || DEFAULT_UA,
    'Referer': ref || targetUrl.origin + '/',
    'Origin': refOrigin,
    'Accept': '*/*',
    ...(cookie ? { Cookie: cookie } : {}),
  };

  const lowerPath = targetUrl.pathname.toLowerCase();
  const isPlaylistPath = lowerPath.endsWith('.m3u8');
  const isDashPath = lowerPath.endsWith('.mpd');
  const incomingRange = request.headers.get('Range');
  if (incomingRange && !isPlaylistPath && !isDashPath) {
    headers['Range'] = incomingRange;
  }

  let upstream, usedProxy = '';
  const expectPlaylist = isPlaylistPath;

  try {
    if (via) {
      usedProxy = via;
      try {
        const client = proxiedFetch(via);
        upstream = await fetchWithSanity(client, targetUrl.toString(), headers, expectPlaylist);
        if (!upstream.ok && needsResidential(targetUrl.hostname)) throw new Error('via failed');
      } catch {
        if (!needsResidential(targetUrl.hostname)) throw new Error('via failed');
        const hit = await findProxy(targetUrl.toString(), headers, targetUrl.hostname, env);
        if (hit) {
          usedProxy = hit.proxy;
          const client = proxiedFetch(hit.proxy);
          upstream = await fetchWithSanity(client, targetUrl.toString(), headers, expectPlaylist);
        } else {
          upstream = await fetch(targetUrl.toString(), {
            headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });
        }
      }
    } else if (needsResidential(targetUrl.hostname)) {
      const hit = await findProxy(targetUrl.toString(), headers, targetUrl.hostname, env);
      if (hit) {
        usedProxy = hit.proxy;
        const client = proxiedFetch(hit.proxy);
        upstream = await fetchWithSanity(client, targetUrl.toString(), headers, expectPlaylist);
      } else {
        upstream = await fetch(targetUrl.toString(), {
          headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
      }
    } else {
      upstream = await fetch(targetUrl.toString(), {
        headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    }
  } catch (e) {
    return new Response('Upstream failed: ' + e.message, { status: 502, headers: cors });
  }

  const respHeaders = new Headers(cors);
  if (usedProxy) respHeaders.set('X-Proxy-Via', usedProxy);

  const ar = upstream.headers.get('Accept-Ranges');
  if (ar) respHeaders.set('Accept-Ranges', ar);
  const cr = upstream.headers.get('Content-Range');
  if (cr) respHeaders.set('Content-Range', cr);

  if (!upstream.ok) {
    const body = await upstream.text();
    respHeaders.set('X-Proxy-Upstream', String(upstream.status));
    return new Response(body.slice(0, 2000), {
      status: upstream.status,
      headers: respHeaders,
    });
  }

  const ct = upstream.headers.get('content-type') || '';
  const isPlaylist = lowerPath.endsWith('.m3u8') || ct.includes('mpegurl');
  const isDash = lowerPath.endsWith('.mpd') || ct.includes('dash+xml');

  if (isDash) {
    let xml = await upstream.text();
    const dir = targetUrl.href.slice(0, targetUrl.href.lastIndexOf('/') + 1);
    if (!/<BaseURL>\s*https?:/i.test(xml)) {
      xml = xml.replace(/(<MPD\b[^>]*>)/i, `$1<BaseURL>${dir}</BaseURL>`);
    }
    respHeaders.set('Content-Type', 'application/dash+xml');
    respHeaders.set('Cache-Control', 'no-cache');
    return new Response(xml, { status: 200, headers: respHeaders });
  }

  if (isPlaylist) {
    const text = await upstream.text();
    // CHANGED vs Worker: base path is /api/live-proxy, not /
    const base = `https://${reqUrl.host}/api/live-proxy?url=`;
    const extras =
      (cookie ? '&cookie=' + encodeURIComponent(cookie) : '') +
      (ref ? '&ref=' + encodeURIComponent(ref) : '') +
      (ua ? '&ua=' + encodeURIComponent(ua) : '') +
      (usedProxy ? '&via=' + encodeURIComponent(usedProxy) : '');

    const parentQuery = targetUrl.search;
    const toAbs = (r) => {
      const u = new URL(r, targetUrl);
      if (!u.search && parentQuery) u.search = parentQuery;
      return u.toString();
    };
    const wrap = (abs) => base + encodeURIComponent(abs) + extras;

    const body = text.split('\n').map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(toAbs(u))}"`);
      return wrap(toAbs(t));
    }).join('\n');

    respHeaders.set('Content-Type', 'application/vnd.apple.mpegurl');
    respHeaders.set('Cache-Control', 'no-cache');
    return new Response(body, { status: 200, headers: respHeaders });
  }

  respHeaders.set('Content-Type', ct || 'application/octet-stream');
  respHeaders.set('Cache-Control', upstream.headers.get('cache-control') || 'no-cache');
  const cl = upstream.headers.get('content-length');
  if (cl) respHeaders.set('Content-Length', cl);
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}
