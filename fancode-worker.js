// ============================================================
//  FANCODE HLS PROXY — Cloudflare Worker
//
//  Endpoints:
//    /                  → built-in Plyr player
//    /?url=<encoded>    → HLS proxy (manifest or segment)
//    /api/proxy?url=…   → same handler, for callers that expect that path
//
//  Locked to a fixed set of front-end origins and a fixed set of
//  upstream hosts, so it cannot be used as an open relay or embedded
//  by a third-party page.
// ============================================================

const REFERER = "https://www.fancode.com/";
const ORIGIN  = "https://www.fancode.com";
const UA      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/* Front-ends allowed to call the proxy. The Origin header is set by the
   browser and cannot be forged from JavaScript, so any page on a different
   domain is rejected here.
 *
 * Safari's native HLS media element does not send Origin for cross-origin
 * <video src> fetches — only Referer — so Referer is checked as a fallback.
 * Front-ends must not use a no-referrer policy. */
const ALLOWED_ORIGINS = [
  "https://dai-fancode.pages.dev",
  // Add other front-ends here as needed, e.g.:
  // "https://sportlink10-ajp.pages.dev",
  // "https://sportlink-sonyliv.pages.dev",
];

/* Upstream hosts this Worker will fetch. Anything else is rejected, so the
   ?url= parameter cannot be abused to relay arbitrary internet traffic. */
const ALLOWED_UPSTREAM = [
  "fancode.com",
  "in-mc-flive.fancode.com",
  "dai-fancode.pages.dev",
];

/* Allow the Worker's own origin as a caller, so the built-in Plyr player
   at "/" can talk to the proxy without a shared secret. */
const ALLOW_SAME_ORIGIN = true;

/* Default stream for the built-in player when no ?url= is supplied. */
const DEFAULT_STREAM =
  "https://in-mc-flive.fancode.com/mumbai/4248491_hindi_hls_ed24a8186993836_1ta-di_h264/1080p.m3u8";

/* ------------------------------------------------------------------ */

function hostAllowed(host) {
  return ALLOWED_UPSTREAM.some(s => host === s || host.endsWith("." + s));
}

/* Return the matched origin if the request is permitted, else null. */
function requestOrigin(request) {
  const origin = request.headers.get("Origin");
  if (origin) {
    return ALLOWED_ORIGINS.includes(origin) ? origin : null;
  }
  const referer = request.headers.get("Referer");
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      if (ALLOWED_ORIGINS.includes(refOrigin)) return refOrigin;
      if (ALLOW_SAME_ORIGIN && refOrigin === new URL(request.url).origin) {
        return refOrigin;
      }
    } catch { /* fall through */ }
  }
  return null;
}

/* CORS headers echo the specific origin rather than `*`. */
function corsHeaders(matchedOrigin) {
  return {
    "Access-Control-Allow-Origin": matchedOrigin || ALLOWED_ORIGINS[0] || "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "*",
    "Vary": "Origin",
  };
}

/* ------------------------------------------------------------------ */

export default {
  async fetch(request) {
    const reqUrl = new URL(request.url);
    const matchedOrigin = requestOrigin(request);

    /* Preflight: only answer if the origin is allowed. */
    if (request.method === "OPTIONS") {
      if (!matchedOrigin) return new Response(null, { status: 403 });
      return new Response(null, { headers: corsHeaders(matchedOrigin) });
    }

    /* ---- /  → built-in Plyr player (no origin check: it is a static page) ---- */
    if (
      (reqUrl.pathname === "/" || reqUrl.pathname === "") &&
      !reqUrl.searchParams.has("url")
    ) {
      return new Response(PLAYER_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    /* ---- /?url= and /api/proxy?url= → proxy handler ---- */
    const isProxyPath =
      reqUrl.pathname === "/" ||
      reqUrl.pathname === "" ||
      reqUrl.pathname === "/api/proxy";

    if (!isProxyPath) {
      return new Response("Not found", { status: 404 });
    }

    /* Every proxy request requires a matched origin. A direct URL visit or
       bare curl produces neither Origin nor matching Referer and lands
       here. */
    if (!matchedOrigin) {
      return new Response("Forbidden: origin not allowed", {
        status: 403,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const CORS = corsHeaders(matchedOrigin);

    const target = reqUrl.searchParams.get("url");
    if (!target) return new Response("Missing ?url=", { status: 400, headers: CORS });

    let parsed;
    try { parsed = new URL(target); } catch {
      return new Response("Invalid ?url=", { status: 400, headers: CORS });
    }
    if (!hostAllowed(parsed.hostname)) {
      return new Response("Host not allowed", { status: 403, headers: CORS });
    }

    let upstream;
    try {
      upstream = await fetchWithRetry(target);
    } catch (e) {
      return new Response("Upstream failed: " + e.message, { status: 502, headers: CORS });
    }

    /* A refusal is not a playlist, whatever the path says. Rewriting an
       HTML error page as one turns each of its lines into a proxy URL, and
       the player ends up with a 200-looking manifest of nonsense. */
    if (!upstream.ok) {
      const body = await upstream.text();
      const errHeaders = new Headers(CORS);
      errHeaders.set("X-Proxy-Upstream", String(upstream.status));
      errHeaders.set("Content-Type", "text/plain; charset=utf-8");
      return new Response(body.slice(0, 2000), {
        status: upstream.status,
        headers: errHeaders,
      });
    }

    const ct = upstream.headers.get("content-type") || "";
    const lower = parsed.pathname.toLowerCase();
    const isPlaylist = lower.endsWith(".m3u8") || ct.includes("mpegurl");

    if (isPlaylist) {
      const text = await upstream.text();
      const base = new URL(target);
      const wrapBase = `${reqUrl.origin}${reqUrl.pathname}?url=`;

      const rewritten = text.split("\n").map((rawLine) => {
        const line = rawLine.trim();
        if (line === "") return rawLine;

        if (line.startsWith("#")) {
          return line.replace(/URI="([^"]+)"/g, (_, uri) => {
            const abs = new URL(uri, base).toString();
            return `URI="${wrapBase}${encodeURIComponent(abs)}"`;
          });
        }

        const abs = new URL(line, base).toString();
        return wrapBase + encodeURIComponent(abs);
      }).join("\n");

      const headers = new Headers(CORS);
      headers.set("Content-Type", "application/vnd.apple.mpegurl");
      headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
      headers.set("CDN-Cache-Control", "no-store");
      return new Response(rewritten, { status: 200, headers });
    }

    /* Segment or key: pipe the bytes back with CORS added. */
    const headers = new Headers(CORS);
    headers.set("Content-Type", ct || "video/mp2t");
    headers.set("Cache-Control", upstream.headers.get("cache-control") || "public, max-age=30");
    return new Response(upstream.body, { status: 200, headers });
  },
};

/* ============================================================
   Fetch with retry — handles transient 403/429/5xx from Fancode
   ============================================================ */
async function fetchWithRetry(url, attempt = 1) {
  const maxAttempts = 4;
  try {
    const res = await fetch(url, {
      headers: {
        "Referer": REFERER,
        "Origin": ORIGIN,
        "User-Agent": UA,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
      },
      redirect: "follow",
    });

    if ((res.status === 403 || res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, 150 * attempt));
      return fetchWithRetry(url, attempt + 1);
    }
    return res;
  } catch (e) {
    if (attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, 150 * attempt));
      return fetchWithRetry(url, attempt + 1);
    }
    throw e;
  }
}

/* ============================================================
   Built-in Plyr player, served at "/"
   ============================================================ */
const PLAYER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Fancode Live · SPORTLINK</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="strict-origin-when-cross-origin">
<link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
<style>
  html,body{margin:0;background:#000;height:100%;overflow:hidden;font-family:'Inter',system-ui,sans-serif}
  #stage{position:relative;width:100vw;height:100vh;background:#000}
  #v{width:100%;height:100%;display:block;background:#000;object-fit:contain}
  .plyr{--plyr-color-main:#3b82f6;width:100vw;height:100vh}
  #status{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:10;pointer-events:none;color:#fff;text-align:center;padding:24px}
  #status.hidden{display:none}
  #status.error{background:rgba(0,0,0,.75);pointer-events:auto}
  #status.error .spin{display:none}
  #status.error #err-icon{display:block}
  #status.error #err-actions{display:flex}
  .spin{width:46px;height:46px;border:3px solid rgba(255,255,255,.14);border-top-color:#3b82f6;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 14px}
  @keyframes spin{to{transform:rotate(360deg)}}
  #err-icon{display:none;font-size:2rem;color:#f87171;margin-bottom:14px}
  #status-text{font-size:.88rem;font-weight:600;color:rgba(255,255,255,.75)}
  #status.error #status-text{color:#fca5a5;font-size:.92rem;line-height:1.6;max-width:520px}
  #err-actions{display:none;margin-top:20px;gap:10px;justify-content:center;flex-wrap:wrap}
  .err-btn{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);color:#fff;font-family:inherit;font-size:.8rem;font-weight:700;padding:9px 22px;border-radius:24px;cursor:pointer;transition:background .15s}
  .err-btn:hover{background:rgba(255,255,255,.2)}
  #top{position:absolute;top:0;left:0;right:0;height:64px;display:flex;align-items:center;gap:12px;padding:0 18px;background:linear-gradient(to bottom,rgba(0,0,0,.75),transparent);z-index:20;transition:opacity .3s ease}
  #stage.hide-ui #top{opacity:0;pointer-events:none}
  #title{color:#fff;font-size:.95rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #badge{margin-left:auto;display:none;align-items:center;gap:7px;padding:6px 14px;border-radius:40px;background:#dc2626;color:#fff;font-size:.7rem;font-weight:800;letter-spacing:.06em}
  #badge.on{display:inline-flex}
  #badge .dot{width:7px;height:7px;border-radius:50%;background:#fff;animation:pulse 1.4s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
</style>
</head>
<body>
  <div id="stage">
    <video id="v" playsinline controls></video>
    <div id="top">
      <div id="title">Fancode Live</div>
      <span id="badge"><span class="dot"></span>LIVE</span>
    </div>
    <div id="status">
      <div>
        <div class="spin"></div>
        <i class="fas fa-exclamation-triangle" id="err-icon"></i>
        <div id="status-text">Loading stream…</div>
        <div id="err-actions">
          <button class="err-btn" onclick="retry()"><i class="fas fa-redo"></i>&nbsp; Retry</button>
        </div>
      </div>
    </div>
  </div>

  <script src="https://cdn.plyr.io/3.7.8/plyr.polyfilled.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js"></script>
  <script>
    const video   = document.getElementById('v');
    const stage   = document.getElementById('stage');
    const status  = document.getElementById('status');
    const txt     = document.getElementById('status-text');
    const titleEl = document.getElementById('title');
    const badge   = document.getElementById('badge');

    const params = new URLSearchParams(location.search);
    const streamParam = params.get('url');
    const titleParam  = params.get('title');

    const SRC = streamParam
      ? '/?url=' + encodeURIComponent(streamParam)
      : '/?url=' + encodeURIComponent(${JSON.stringify(DEFAULT_STREAM)});

    if (titleParam) titleEl.textContent = titleParam;

    const player = new Plyr(video, {
      controls: ['play-large','restart','play','progress','current-time','duration',
                 'mute','volume','captions','settings','pip','airplay','fullscreen'],
      settings: ['captions','quality','speed'],
      autoplay: true,
      seekTime: 10,
      keyboard: { focused: true, global: true },
    });

    let hls = null;
    let hideTimer = null;
    let retries = 0;
    const MAX = 8;

    function setStatus(t, err) {
      if (!t) { status.classList.add('hidden'); status.classList.remove('error'); return; }
      status.classList.remove('hidden');
      status.classList.toggle('error', !!err);
      txt.textContent = t;
    }

    function showUI() { stage.classList.remove('hide-ui'); clearTimeout(hideTimer); }
    function scheduleHide() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { if (!video.paused) stage.classList.add('hide-ui'); }, 3200);
    }
    stage.addEventListener('mousemove', () => { showUI(); if (!video.paused) scheduleHide(); });
    video.addEventListener('play', scheduleHide);
    video.addEventListener('pause', showUI);

    function start() {
      if (hls) { try { hls.destroy(); } catch(e){} hls = null; }
      setStatus('Loading stream…', false);

      if (window.Hls && Hls.isSupported()) {
        hls = new Hls({
          lowLatencyMode: true,
          enableWorker: true,
          backBufferLength: 30,
          manifestLoadingTimeOut: 20000,
          manifestLoadingMaxRetry: 6,
          fragLoadingTimeOut: 30000,
          fragLoadingMaxRetry: 8,
        });
        hls.loadSource(SRC);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setStatus(null);
          retries = 0;
          if (video.duration === Infinity) badge.classList.add('on');
          player.play().catch(() => {});
        });
        hls.on(Hls.Events.LEVEL_LOADED, (_, d) => {
          if (d.details && d.details.live) badge.classList.add('on');
        });
        hls.on(Hls.Events.ERROR, (_, d) => {
          if (!d.fatal) return;
          if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
            if (retries < MAX) {
              retries++;
              setStatus('Reconnecting (' + retries + '/' + MAX + ')…', false);
              setTimeout(() => hls && hls.startLoad(), 800);
            } else {
              setStatus('Stream is not available right now. The upstream CDN refused the request or the stream went offline.', true);
            }
          } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          } else {
            setStatus('Playback error: ' + (d.details || d.type), true);
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = SRC;
        video.addEventListener('loadedmetadata', () => {
          setStatus(null);
          if (video.duration === Infinity) badge.classList.add('on');
          player.play().catch(() => {});
        }, { once: true });
        video.addEventListener('error', () => setStatus('Native HLS playback failed.', true), { once: true });
      } else {
        setStatus('HLS is not supported in this browser.', true);
      }
    }

    function retry() { retries = 0; start(); }
    start();
  </script>
</body>
</html>`;
