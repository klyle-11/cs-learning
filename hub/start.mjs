// Starts the hub: the server (../server-cpp/hubd) on the live workspace, ../data.
// Written in Node so the same commands work on macOS, Linux and Windows.
//
//   node start.mjs [folder] [--network] [--insecure] [--https-local] [--pair-local] [--scratch] [hubd options]
//   node start.mjs cert | new-authority | build | test
//
// The first run makes data/ as a copy of sample/, fetches the page's libraries
// and builds the server. Settings, all optional (environment variables):
//   HOST=0.0.0.0     listen on the network (what --network sets)      PORT=4400
//   HUB_STATE=<dir>  certificates and paired devices                  HUB_QUOTA_MB=<n>
//   HUB_HOSTS=a,b    further names the server may be reached by       HUB_PAIR_LOCAL=1  HUB_TLS=1  HUB_INSECURE_HTTP=1
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, cpSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)), top = resolve(here, '..');
const server = join(top, 'server-cpp'), exe = join(server, process.platform === 'win32' ? 'hubd.exe' : 'hubd');
const env = process.env, args = process.argv.slice(2);
const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { stdio: 'inherit', ...opts }).status ?? 1;

// Windows: the compiler, make and bash come from MSYS2, which does not put
// itself on the PATH. `--win` (what the ":win" scripts pass, and what happens
// anyway when this runs on Windows) adds its folders for this run only.
// MSYS2 somewhere other than C:\msys64: set MSYS2_ROOT.
const win = process.platform === 'win32' || args.includes('--win');
if (args.includes('--win')) args.splice(args.indexOf('--win'), 1);
if (win) {
  const root = env.MSYS2_ROOT || 'C:\\msys64';
  if (process.platform !== 'win32') { console.error('The ":win" scripts are for Windows. On macOS, Linux and Raspberry Pi OS use the same script without ":win".'); process.exit(1); }
  if (!existsSync(root)) { console.error(`MSYS2 was not found at ${root}. See WINDOWS.md, or set MSYS2_ROOT.`); process.exit(1); }
  env.PATH = [join(root, 'ucrt64', 'bin'), join(root, 'usr', 'bin'), env.PATH].join(';');
}

function build() {
  const made = run('make', ['-s', '-C', server, 'hubd']);
  if (made !== 0 && !existsSync(exe)) {
    console.error('\nThe server could not be built. It needs a C++ compiler, make and mbedTLS 3.\n  macOS:            brew install mbedtls\n  Windows:          see WINDOWS.md\n  Raspberry Pi OS:  see WINDOWS.md, "Raspberry Pi and other Linux"\n');
    process.exit(1);
  }
}

const what = args[0];
if (what === 'build') { build(); process.exit(0); }
if (what === 'test') { build(); process.exit(run('bash', ['test/contract.sh'], { cwd: server })); }
if (what === 'cert' || what === 'new-authority') { build(); process.exit(run(exe, [what === 'cert' ? '--make-cert' : '--new-authority', ...args.slice(1)])); }

// Options of this script; anything else is handed to the server as it is.
const flags = new Set(), rest = [];
for (const a of args) (['--network', '--insecure', '--https-local', '--pair-local', '--scratch'].includes(a) ? flags.add(a) : rest.push(a));
let folder = env.HUB_ROOT || join(top, 'data');
if (rest.length && !rest[0].startsWith('-')) folder = resolve(rest.shift());
if (flags.has('--scratch')) {
  // The scratch workspace, on its own port, with state of its own: for trying things without touching data/ or the real pairings.
  folder = join(top, 'data-test');
  env.PORT ||= '4396';
  env.HUB_STATE ||= join(server, 'build', 'scratch-state');
  rest.push('--workspaces', join(server, 'build', 'scratch-workspaces'));
  mkdirSync(join(server, 'build'), { recursive: true });
}
if (folder === join(top, 'data') && !existsSync(folder)) {
  if (existsSync(join(top, 'sample'))) cpSync(join(top, 'sample'), folder, { recursive: true }); else mkdirSync(folder, { recursive: true });
  console.log('made data/ from sample/');
}
// The page's three libraries (markdown, code colouring, the HTML sanitiser) come from npm.
if (!existsSync(join(here, 'node_modules', 'marked'))) run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'], { cwd: here });
build();

const argv = [folder, '--www', here, ...rest];
const host = flags.has('--network') ? '0.0.0.0' : env.HOST;
if (env.PORT) argv.push('--port', env.PORT);
if (host) argv.push('--host', host);
if (env.HUB_QUOTA_MB) argv.push('--quota-mb', env.HUB_QUOTA_MB);
if (flags.has('--pair-local') || env.HUB_PAIR_LOCAL === '1') argv.push('--pair-local');
if (flags.has('--https-local') || env.HUB_TLS === '1') argv.push('--tls');
if (flags.has('--insecure') || env.HUB_INSECURE_HTTP === '1') argv.push('--insecure-http');
for (const name of (env.HUB_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean)) argv.push('--allow-host', name);

const child = spawn(exe, argv, { stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
