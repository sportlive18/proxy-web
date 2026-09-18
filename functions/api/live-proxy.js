/* Cloudflare Pages Function — converted from the Vercel/Node handler.
 *
 * One structural difference from the Node version: Cloudflare Workers
 * cannot fetch through an arbitrary HTTP proxy.
 *
 * Workers' fetch() resolves the URL's own hostname and sends an origin-form
 * request (GET /path, Host: target). There is no dispatcher / ProxyAgent
 * equivalent, and pointing fetch at the proxy host — fetch(`http://${proxy}/${url}`)
 * — does NOT produce the absolute-form request line (GET http://target/path)
 * that a forward HTTP proxy expects. It produces a request to the proxy's
 * own web server for a path that happens to look like a URL. So the
 * residential-proxy fallback from the Node version cannot be reproduced
 * here, and the previous conversion's getViaProxy() was a no-op dressed up
 * as a proxy hop.
 *
 * Practical consequence: SonyLiv and Hotstar, which refuse hosted networks,
 * will 403 from this deployment the way they 403 from any datacenter. If
 * you need them, the proxy hop has to live somewhere that can actually
 * speak to a forward proxy — the Node handler, or a relay you run — and
 * this function should forward to it.
 *
 * ?via= is still accepted for URL compatibility and ignored.
 *
 * Everything else from the Node version is preserved, plus fixes carried
 * over from the original:
 *   - allowlist (unchanged)
 *   - Range forwarded; Content-Range / Accept-Ranges / Content-Length
 *     passed back, so #EXT-X-BYTERANGE and DASH SegmentBase work
 *   - redirects followed manually, allowlist re-checked per hop, one
 *     deadline across the whole chain
 *   - DASH BaseURL injected only when no BaseURL exists at all (the
 *     previous /<BaseURL>\s*https?:/ guard let a relative BaseURL through
 *     and then shadowed it with a second MPD-level BaseURL)
 *   - DASH BaseURL carries the manifest query, matching the HLS path
 *   - segment bodies streamed through
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const ALLOWED = ['fancode.com', 'akamaized.net', 'hotstar.com', 'jio.com'];

const MAX_REDIRECTS = 5;
const UPSTREAM_TIMEOUT_MS = 15000;

const allowed = (h) => ALLOWED.some(s => h === s || h.endsWith('.' + s));

const XML_ESCAPES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };
const escapeXml = (s) => s.replace(/[<>&'"]/g, c => XML_ESCAPES[c]);

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

/* fetch with one deadline across the whole redirect chain, and every hop
   re-checked against the allowlist. Without redirect: 'manual', a 302 from
   an allowlisted host is a way to make this proxy reach anything. */
async function fetchBounded(url, headers, deadline, hops = 0) {
  if (hops > MAX_REDIRECTS) throw new Error('Too many redirects');
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Upstream deadline exceeded');

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), remaining);
  try {
    const r = await fetch(url, {
      headers,
      redirect: 'manual',
      signal: controller.signal,
    });

    const isRedirect =
      r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400);
    if (!isRedirect) return r;

    const loc = r.headers.get('location');
    if (!loc) throw new Error('Redirect with no readable Location');
    const next = new URL(loc, url);
    if (!allowed(next.hostname)) {
      throw new Error('Redirect to disallowed host: ' + next.hostname);
    }
    return fetchBounded(next.toString(), headers, deadline, hops + 1);
  } finally {
    clearTimeout(tid);
  }
}

export async function onRequest(context) {
  const { request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get('url')    || '';
  const cookie = url.searchParams.get('cookie') || '';
  const ref    = url.searchParams.get('ref')    || '';
  const ua     = url.searchParams.get('ua')     || '';
  // ?via= accepted but ignored — see header comment.

  if (!target) {
    return new Response('Missing ?url=', { status: 400, headers: corsHeaders() });
  }

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
  try {
    upstream = await fetchBounded(
      targetUrl.toString(),
      fwdHeaders,
      Date.now() + UPSTREAM_TIMEOUT_MS,
    );
  } catch (e) {
    return new Response('Upstream failed: ' + e.message, {
      status: 502,
      headers: corsHeaders(),
    });
  }

  const outHeaders = { ...corsHeaders() };

  if (!upstream.ok) {
    const body = await upstream.text();
    outHeaders['X-Upstream-Status'] = String(upstream.status);
    return new Response(body.slice(0, 2000), {
      status: upstream.status,
      headers: outHeaders,
    });
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
      const dir =
        targetUrl.href.slice(0, targetUrl.href.lastIndexOf('/') + 1) +
        targetUrl.search;
      xml = xml.replace(/(<MPD\b[^>]*>)/i, `$1<BaseURL>${escapeXml(dir)}</BaseURL>`);
    }
    return new Response(xml, {
      status: 200,
      headers: {
        ...outHeaders,
        'Content-Type': 'application/dash+xml',
        'Cache-Control': 'no-cache',
      },
    });
  }

  if (isPlaylist) {
    const text = await upstream.text();
    const base = `https://${url.host}/api/live-proxy`;
    const extras =
      (cookie ? '&cookie=' + encodeURIComponent(cookie) : '') +
      (ref    ? '&ref='    + encodeURIComponent(ref)    : '') +
      (ua     ? '&ua='     + encodeURIComponent(ua)     : '');

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
      headers: {
        ...outHeaders,
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache',
      },
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
