// Disposable certificate audit. Never reads or replaces the real hub state.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const build = path.resolve('server-cpp/build');
const work = mkdtempSync(path.join(build, 'cert-audit-'));
const state = path.join(work, 'state'); mkdirSync(state);
const exe = process.env.HUBD || path.join(build, process.platform === 'win32' ? 'hubd-own.exe' : 'hubd-own');
const openssl = process.env.OPENSSL || (process.platform === 'win32' ? 'C:/Program Files/Git/mingw64/bin/openssl.exe' : 'openssl');
function run(program, args, good = true) {
  const r = spawnSync(program, args, { encoding: 'utf8', timeout: 15000 });
  if (r.error) throw r.error;
  if (good && r.status !== 0) throw new Error(r.stderr || r.stdout);
  return r;
}
run(exe, ['--make-cert', '--state', state, '--allow-host', 'audit-hub.local']);
assert(!existsSync(path.join(state, 'ca-key.pem')));
const ca = path.join(state, 'ca.pem'), issuer = path.join(state, 'issuer.pem');
const leaf = path.join(state, 'cert.pem');
run(openssl, ['verify', '-CAfile', ca, '-untrusted', issuer, '-purpose', 'sslserver', '-verify_hostname', 'audit-hub.local', leaf]);
let count = 1;
function forged(name, san, purpose = 'sslserver', accepted = false, eku) {
  const key = path.join(work, name + '.key'), req = path.join(work, name + '.csr'), cert = path.join(work, name + '.pem'), ext = path.join(work, name + '.ext');
  writeFileSync(ext, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${eku || (purpose === 'smimesign' ? 'emailProtection' : 'serverAuth')}\nsubjectAltName=${san}\n`);
  run(openssl, ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', '/CN=Audit', '-keyout', key, '-out', req]);
  run(openssl, ['x509', '-req', '-in', req, '-CA', issuer, '-CAkey', path.join(state, 'issuer-key.pem'), '-set_serial', String(count++), '-days', '1', '-extfile', ext, '-out', cert]);
  const r = run(openssl, ['verify', '-CAfile', ca, '-untrusted', issuer, '-purpose', purpose, cert], false);
  assert.equal(r.status === 0, accepted, name + ': ' + r.stderr);
  console.log(name + ': ' + (purpose === 'any' ? 'generic chain valid; application policy checked separately' : accepted ? 'accepted (scope demonstrated)' : 'rejected'));
  return cert;
}
forged('public-dns', 'DNS:example.com');
forged('public-ip', 'IP:8.8.8.8');
forged('public-ipv6', 'IP:2001:4860:4860::8888');
forged('other-local', 'DNS:unrelated.local', 'sslserver', true);
forged('other-private-ip', 'IP:192.168.1.1', 'sslserver', true);
// New issuers restrict purpose too; existing issuers need deliberate rotation.
forged('unrelated-email', 'email:audit@example.com', 'smimesign', false);
forged('client-identity', 'DNS:unrelated.local', 'sslclient', false, 'clientAuth');
forged('mixed-san', 'DNS:unrelated.local,DNS:example.com');
forged('suffix-trick', 'DNS:unrelated.local.example.com');
// A retained issuer must not bypass path length by signing another ordinary CA.
const childKey = path.join(work, 'child.key'), childReq = path.join(work, 'child.csr'), childCert = path.join(work, 'child.pem'), childExt = path.join(work, 'child.ext');
writeFileSync(childExt, 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n');
run(openssl, ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', '/CN=Child audit CA', '-keyout', childKey, '-out', childReq]);
run(openssl, ['x509', '-req', '-in', childReq, '-CA', issuer, '-CAkey', path.join(state, 'issuer-key.pem'), '-set_serial', '999', '-days', '1', '-extfile', childExt, '-out', childCert]);
const nested = path.join(work, 'nested.pem'), nestedChain = path.join(work, 'nested-chain.pem');
run(openssl, ['x509', '-req', '-in', path.join(work, 'other-local.csr'), '-CA', childCert, '-CAkey', childKey, '-set_serial', '1000', '-days', '1', '-extfile', path.join(work, 'other-local.ext'), '-out', nested]);
writeFileSync(nestedChain, readFileSync(childCert, 'utf8') + readFileSync(issuer, 'utf8'));
assert.notEqual(run(openssl, ['verify', '-CAfile', ca, '-untrusted', nestedChain, '-purpose', 'sslserver', nested], false).status, 0, 'sub-CA escape');
console.log('Additional subordinate CA: rejected');
// OpenSSL purpose=any is not a code-signing policy test; Windows checks below.
const codeCert = forged('code-signing', 'DNS:unrelated.local', 'any', true, 'codeSigning');
if (process.platform === 'win32') {
  const pwsh = process.env.PWSH || 'pwsh.exe';
  run(pwsh, ['-NoProfile', '-File', path.resolve('server-cpp/test/certificate-policy.ps1'), '-Root', ca, '-Issuer', issuer, '-Certificate', codeCert, '-Purpose', '1.3.6.1.5.5.7.3.3']);
  console.log('Windows code-signing application policy: rejected');
}
run(openssl, ['verify', '-CAfile', ca, '-untrusted', issuer, '-purpose', 'sslserver', '-verify_hostname', 'example.com', leaf], false).status !== 0 || assert.fail('Wrong hostname accepted');
const partial = path.join(work, 'partial'); cpSync(state, partial, { recursive: true });
const before = readFileSync(path.join(partial, 'ca.pem'));
unlinkSync(path.join(partial, 'issuer.pem'));
const partialRun = run(exe, ['--make-cert', '--state', partial], false);
assert.notEqual(partialRun.status, 0, 'incomplete state must fail closed');
assert.deepEqual(readFileSync(path.join(partial, 'ca.pem')), before, 'partial state must not replace installed identity');
console.log('Wrong hostname and incomplete-state rotation: rejected');
console.log('Certificate audit passed; disposable evidence at ' + work);
