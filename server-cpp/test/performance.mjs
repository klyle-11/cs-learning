// Isolated HTTP regressions: node server-cpp/test/performance.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const serverDir = fileURLToPath(new URL('../', import.meta.url));
const build = path.join(serverDir, 'build');
await mkdir(build, { recursive: true });
const work = await mkdtemp(path.join(build, 'performance-'));
assert.ok(work.startsWith(build + path.sep));
const ws = path.join(work, 'ws'), state = path.join(work, 'state'), spaces = path.join(work, 'spaces');
await mkdir(ws); await mkdir(state); await mkdir(path.join(spaces, 'other'), { recursive: true });
await writeFile(path.join(ws, 'FRONTPAGE.md'), '# Performance\n');
await writeFile(path.join(spaces, 'other', 'FRONTPAGE.md'), '# Other\n');
for (let i = 0; i < 500; i++) await writeFile(path.join(ws, `doc-${i}.md`), `# Document ${i}\n`);
const port = Number(process.env.HUB_PERF_PORT || 4431), base = `http://localhost:${port}`;
const exe = process.env.HUBD || path.join(build, process.platform === 'win32' ? 'hubd-own.exe' : 'hubd-own');
let server, log = '', passed = false;
async function start() {
  server = spawn(exe, [ws, '--www', path.resolve(serverDir, '../hub'), '--state', state, '--workspaces', spaces,
    '--port', String(port), '--profile', 'esp32-psram'], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.on('error', (e) => { log += e.message; });
  server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/config')).ok) return; } catch {}
    if (server.exitCode != null) throw new Error(log);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Server did not start: ' + log);
}
async function stop() {
  if (!server || server.exitCode != null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill(); await exited;
}
try {
  await start();
  const first = await fetch(base + '/api/docs'), tag = first.headers.get('etag'), bytes = (await first.text()).length;
  assert.equal(first.status, 200); assert.ok(tag);
  const headers = { 'If-None-Match': tag };
  const same = await fetch(base + '/api/docs', { headers });
  assert.equal(same.status, 304); assert.equal((await same.text()).length, 0);
  assert.match(same.headers.get('cache-control'), /private.*no-cache/);
  const denied = await fetch(base + '/api/docs', { headers: { ...headers, Origin: 'https://evil.example' } });
  assert.equal(denied.status, 403, 'conditional requests still pass authorization/origin checks');
  const uploaded = await fetch(base + '/api/upload?path=new.md', { method: 'POST', body: '# New\n' });
  assert.equal(uploaded.status, 200);
  const changed = await fetch(base + '/api/docs', { headers });
  assert.equal(changed.status, 200); assert.notEqual(changed.headers.get('etag'), tag);
  assert.ok((await changed.json()).some((d) => d.path === 'new.md'));
  const beforeBoot = changed.headers.get('etag');
  await stop(); await start();
  const rebooted = await fetch(base + '/api/docs', { headers: { 'If-None-Match': beforeBoot } });
  assert.equal(rebooted.status, 200); assert.notEqual(rebooted.headers.get('etag'), beforeBoot);
  await rebooted.arrayBuffer();
  const cfg = await (await fetch(base + '/api/config')).json();
  const switched = await fetch(base + '/api/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root: path.join(spaces, 'other').replaceAll('\\', '/') }) });
  assert.equal(switched.status, 200);
  const stale = await fetch(base + '/api/docs', { headers: { ...headers, 'X-Hub-Workspace': cfg.workspace } });
  assert.equal(stale.status, 412, 'cached list never bypasses stale workspace checks');
  const other = await fetch(base + '/api/docs', { headers });
  assert.equal(other.status, 200); assert.notEqual(other.headers.get('etag'), tag);
  assert.equal((await other.json()).length, 1);
  console.log(`Performance: 6 scenarios passed; unchanged list body ${bytes} -> 0 bytes`);
  passed = true;
} finally {
  await stop();
  if (passed) await rm(work, { recursive: true, force: true });
  else console.error('Scratch files retained at ' + work);
}
