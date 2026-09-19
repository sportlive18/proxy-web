# Deploy in vercel use proxy url -----  

let LOCAL_PROXY = '';
let IN_PROXY = '';
try {
  const _lp = new URLSearchParams(location.search).get('lp');
  if (_lp !== null) {
    if (!_lp || _lp === 'off') { localStorage.removeItem('fc_local_proxy'); }
    else { localStorage.setItem('fc_local_proxy', _lp); }
  }
  LOCAL_PROXY = localStorage.getItem('fc_local_proxy') || '';
  IN_PROXY = localStorage.getItem('in_proxy')
    || 'https://your.vercel.app/api/live-proxy?url=';
} catch { }
function viaLocalProxy(url) { return LOCAL_PROXY + '?url=' + encodeURIComponent(url); }
