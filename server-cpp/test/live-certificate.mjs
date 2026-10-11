// Read only public endpoints and peer certificates. Never installs trust.
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const host = process.argv[2], port = Number(process.argv[3] || 443);
if (!host) throw new Error('Supply the board IP and optional port');
const dir = path.resolve('server-cpp/build/cert-audit-live'); mkdirSync(dir, { recursive: true });
const openssl = process.env.OPENSSL || (process.platform === 'win32' ? 'C:/Program Files/Git/mingw64/bin/openssl.exe' : 'openssl');
// Capture output, extract public certificates only; never print session keys.
const peer = spawnSync(openssl, ['s_client', '-connect', `${host}:${port}`, '-showcerts', '-ign_eof'], {
  input: `GET /hub-ca.crt HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`, encoding: 'utf8', timeout: 12000
});
const chain = (peer.stdout || '').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
if (!chain || chain.length < 2) throw new Error('Could not read the live certificate chain: ' + (peer.error?.message || 'handshake failed'));
writeFileSync(path.join(dir, 'leaf.pem'), chain[0] + '\n');
writeFileSync(path.join(dir, 'issuer.pem'), chain[1] + '\n');
console.log('Live handshake:', peer.stdout.match(/New, TLS[^\r\n]+/)?.[0] || 'chain received');
const ca = await new Promise((resolve, reject) => {
  const r = http.get({ host, port, path: '/hub-ca.crt', timeout: 8000 }, (res) => {
    let text = ''; res.setEncoding('utf8'); res.on('data', (s) => { text += s; if (text.length > 16384) r.destroy(new Error('Oversized certificate')); });
    res.on('end', () => res.statusCode === 200 ? resolve(text) : reject(new Error('CA HTTP ' + res.statusCode)));
  }); r.on('timeout', () => r.destroy(new Error('CA timeout'))); r.on('error', reject);
});
writeFileSync(path.join(dir, 'ca.pem'), ca);
for (const args of [
  ['x509', '-in', path.join(dir, 'ca.pem'), '-noout', '-fingerprint', '-sha256', '-subject', '-dates'],
  ['x509', '-in', path.join(dir, 'issuer.pem'), '-noout', '-ext', 'nameConstraints,basicConstraints,extendedKeyUsage'],
  ['x509', '-in', path.join(dir, 'leaf.pem'), '-noout', '-ext', 'subjectAltName,extendedKeyUsage', '-dates'],
  ['verify', '-CAfile', path.join(dir, 'ca.pem'), '-untrusted', path.join(dir, 'issuer.pem'), '-purpose', 'sslserver', '-verify_ip', host, path.join(dir, 'leaf.pem')]
]) {
  const r = spawnSync(openssl, args, { encoding: 'utf8', timeout: 10000 });
  console.log(r.stdout.trim()); if (r.status !== 0) throw new Error(r.stderr);
}
console.log('Chain/IP verification uses the downloaded CA; independently compare its full fingerprint with the board before trusting. Public evidence: ' + dir);
