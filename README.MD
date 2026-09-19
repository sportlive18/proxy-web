# 🚀 Live Proxy — Vercel Deployment


## ⚙️ How It Works

```js
let LOCAL_PROXY = '';
let IN_PROXY = '';

try {
  const _lp = new URLSearchParams(location.search).get('lp');

  if (_lp !== null) {
    if (!_lp || _lp === 'off') {
      localStorage.removeItem('fc_local_proxy');
    } else {
      localStorage.setItem('fc_local_proxy', _lp);
    }
  }

  LOCAL_PROXY = localStorage.getItem('fc_local_proxy') || '';
  IN_PROXY =
    localStorage.getItem('in_proxy') ||
    'https://your.vercel.app/api/live-proxy?url=';
} catch {}

function viaLocalProxy(url) {
  return LOCAL_PROXY + '?url=' + encodeURIComponent(url);
}
```

## ⚖️ License & Disclaimer

This repository is provided **as-is** for **educational and research purposes only**.

- 🚫 Not intended for production use without proper security hardening
- 🚫 Do not use to scrape, bypass restrictions, or violate any platform's terms
- ✅ Use to learn how proxy routing, serverless functions, and browser storage work

**The author is not responsible for any misuse of this code.**
