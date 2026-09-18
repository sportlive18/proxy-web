/* Cloudflare Pages Function — public endpoint.
 *
 * The residential-proxy hop is delegated to a Node relay (see Part 2).
 * Cloudflare Workers cannot fetch through an arbitrary HTTP proxy:
 * fetch() has no proxy option, and cloudflare:sockets' startTls() verifies
 * the peer certificate against the proxy hostname, not the origin, so a
 * CONNECT tunnel to an HTTPS origin fails closed. See tunnelfetch's
 * analysis for the measured details.
 *
 * So this function handles:
 *   - the allowlist and CORS
 *   - direct fetches (FanCode, which is geographic-only and works from bom1)
 *   - playlist rewriting for all branches
 *   - forwarding to the relay for hosts that need a residential IP
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const ALLOWED = [
  'fancode.com',
  'akamaized.net',
  'hotstar.com',
  'jio.com',
  'cloudplay-sonyliv.pages.dev', // auto-updating SonyLIV playlist host
  'slivcdn.com',                 // SonyLIV CDN (covers dishmt.slivcdn.com too)
  'dishmt.slivcdn.com',
];

const NEEDS_RESIDENTIAL = ['sonydaimenew.akamaized.net', 'hotstar.com'];

/* The relay's public URL. Set this in Pages → Settings → Environment
   variables as RELAY_URL. */
const RELAY_URL = 'https://your-relay.up.railway.app/api/relay';

const MAX_REDIRECTS = 5;
const UPSTREAM_TIMEOUT_MS = 15000;

const allowed = (h) => ALLOWED.some(s => h === s || h.endsWith('.' + s));
const needsResidential = (h) => NEEDS_RESIDENTIAL.some(s => h === s || h.endsWith('.' + s));

const XML_ESCAPES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };
const escapeXml = (s) => s.replace(/[<>&'"]/g, c => XML_ESCAPES[c]);

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

/* fetch with one deadline across the whole redirect chain, every hop
   re-checked against the allowlist. */
async function fetchBounded(url, headers, deadline, hops = 0) {
  if (hops > MAX_REDIRECTS) throw new Error('Too many redirects');
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Upstream deadline exceeded');

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), remaining);
  try {
    const r = await fetch(url, { headers, redirect: 'manual', signal: controller.signal });
    const isRedirect = r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400);
    if (!isRedirect) return r;

    const loc = r.headers.get('location');
    if (!loc) throw new Error('Redirect with no readable Location');
    const next = new URL(loc, url);
    if (!allowed(next.hostname)) throw new Error('Redirect to disallowed host: ' + next.hostname);
    return fetchBounded(next.toString(), headers, deadline, hops + 1);
  } finally {
    clearTimeout(tid);
  }
}

/* Forward to the Node relay, which has undici and can do the real proxy hop. */
async function fetchViaRelay(target, headers, cookie, ref, ua) {
  const relayUrl = new URL(RELAY_URL);
  relayUrl.searchParams.set('url', target);

  const relayHeaders = {
    'User-Agent': headers['User-Agent'],
    'Referer': headers['Referer'],
    'Origin': headers['Origin'],
    'Accept': '*/*',
    ...(cookie ? { Cookie: cookie } : {}),
  };

  const r = await fetch(relayUrl.toString(), {
    headers: relayHeaders,
    signal: AbortSignal.timeout(20000),
  });

  // The relay passes X-Proxy-Via back so the playlist can pin segments.
  return r;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get('url') || '';
  const cookie = url.searchParams.get('cookie') || '';
  const ref = url.searchParams.get('ref') || '';
  const ua = url.searchParams.get('ua') || '';
  const via = url.searchParams.get('via') || '';

  if (!target) return new Response('Missing ?url=', { status: 400, headers: corsHeaders() });

  let targetUrl;
  try { targetUrl = new URL(target); }
  catch { return new Response('Invalid url', { status: 400, headers: corsHeaders() }); }

  if (!allowed(targetUrl.hostname)) {
    return new Response('Host not allowed', { status: 403, headers: corsHeaders() });
  }

  let refOrigin = targetUrl.origin;
  if (ref) { try { refOrigin = new URL(ref).origin; } catch { /* keep */ } }

  const fwdHeaders = {
    'User-Agent': ua || DEFAULT_UA,
    'Referer': ref || targetUrl.origin + '/',
    'Origin': refOrigin,
    'Accept': '*/*',
    ...(cookie ? { Cookie: cookie } : {}),
  };

  const range = request.headers.get('range');
  if (range) fwdHeaders['Range'] = range;

  let upstream;
  let usedProxy = '';

  try {
    if (needsResidential(targetUrl.hostname)) {
      // Route through the Node relay, which speaks to the residential proxy.
      upstream = await fetchViaRelay(
        targetUrl.toString(),
        fwdHeaders,
        cookie,
        ref,
        ua,
      );
      usedProxy = upstream.headers.get('X-Proxy-Via') || '';
    } else if (via) {
      /* A pinned segment from a playlist — go through the relay with the
         pin so the relay doesn't have to search the pool again. */
      upstream = await fetchViaRelay(
        targetUrl.toString(),
        fwdHeaders,
        cookie,
        ref,
        ua,
      );
      usedProxy = upstream.headers.get('X-Proxy-Via') || via;
    } else {
      // FanCode: geographic block only, and bom1 clears it.
      upstream = await fetchBounded(
        targetUrl.toString(),
        fwdHeaders,
        Date.now() + UPSTREAM_TIMEOUT_MS,
      );
    }
  } catch (e) {
    return new Response('Upstream failed: ' + e.message, {
      status: 502,
      headers: corsHeaders(),
    });
  }

  const outHeaders = { ...corsHeaders() };
  if (usedProxy) outHeaders['X-Proxy-Via'] = usedProxy;

  if (!upstream.ok) {
    const body = await upstream.text();
    outHeaders['X-Upstream-Status'] = String(upstream.status);
    return new Response(body.slice(0, 2000), { status: upstream.status, headers: outHeaders });
  }

  const ar = upstream.headers.get('accept-ranges');
  if (ar) outHeaders['Accept-Ranges'] = ar;
  const cr = upstream.headers.get('content-range');
  if (cr) outHeaders['Content-Range'] = cr;
  if (upstream.status === 206) {
    const cl = upstream.headers.get('content-length');
    if (cl) outHeaders['Content-Length'] = cl;
  }

  const ct = upstream.headers.get('content-type') || '';
  const path = targetUrl.pathname.toLowerCase();
  const isPlaylist = path.endsWith('.m3u8') || ct.includes('mpegurl');
  const isDash = path.endsWith('.mpd') || ct.includes('dash+xml');

  if (isDash) {
    let xml = await upstream.text();
    // Inject only when there is no BaseURL at all. A relative BaseURL is
    // still a BaseURL, and a second MPD-level one would shadow it.
    if (!/<BaseURL\b/i.test(xml)) {
      const dir = targetUrl.href.slice(0, targetUrl.href.lastIndexOf('/') + 1) + targetUrl.search;
      xml = xml.replace(/(<MPD\b[^>]*>)/i, `$1<BaseURL>${escapeXml(dir)}</BaseURL>`);
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
      (ref ? '&ref=' + encodeURIComponent(ref) : '') +
      (ua ? '&ua=' + encodeURIComponent(ua) : '') +
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
      if (t.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(toAbs(u))}"`);
      }
      return wrap(toAbs(t));
    }).join('\n');

    return new Response(body, {
      status: 200,
      headers: { ...outHeaders, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' },
    });
  }

  // Segments and keys — stream the body through, preserve 206.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      ...outHeaders,
      'Content-Type': ct || 'application/octet-stream',
      'Cache-Control': upstream.headers.get('cache-control') || 'no-cache',
    },
  });
}
