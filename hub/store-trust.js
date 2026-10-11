const state = document.getElementById('state');
const secure = location.protocol === 'https:';
state.textContent = secure
  ? 'This page reached you encrypted. If there was no warning, this device already trusts the store certificate.'
  : 'Use the HTTPS address shown on the board before opening the reader.';
state.classList.toggle('ok', secure);
document.getElementById('open').href = `https://${location.host}/`;

fetch('/api/trust').then((response) => {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}).then((trust) => {
  document.getElementById('print').textContent = trust.fingerprint.split(':').reduce(
    (out, byte, index) => out + (index && index % 8 === 0 ? '\n' : index ? ':' : '') + byte,
    '',
  );
  document.getElementById('print').style.whiteSpace = 'pre';
}).catch(() => { document.getElementById('print').textContent = 'could not be fetched'; });
