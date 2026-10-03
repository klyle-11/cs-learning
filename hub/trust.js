// The trust page: say how the page arrived, show the authority's fingerprint,
// and open the steps for the kind of device this is.
const state = document.getElementById('state');
const secure = location.protocol === 'https:';
state.textContent = secure
  ? 'This page reached you encrypted. If your browser showed no warning on the way here, this device already trusts the hub.'
  : 'This page reached you unencrypted, which is fine for this page only: it holds nothing private. The reader itself is only served over HTTPS.';
state.classList.toggle('ok', secure);
document.getElementById('open').href = 'https://' + location.host + '/';

fetch('/api/trust').then((r) => r.json()).then((t) => {
  // In groups of four bytes, so it can be compared a piece at a time.
  document.getElementById('print').textContent = t.fingerprint.split(':').reduce((out, b, i) => out + (i && i % 8 === 0 ? '\n' : i ? ':' : '') + b, '');
  document.getElementById('print').style.whiteSpace = 'pre';
}).catch(() => { document.getElementById('print').textContent = 'could not be fetched'; });

const ua = navigator.userAgent;
const os = /iPhone|iPad|iPod/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 1) ? 'ios' : /Android/.test(ua) ? 'android' : /Mac/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'windows' : 'linux';
document.querySelector(`details[data-os="${os}"]`)?.setAttribute('open', '');
