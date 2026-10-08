// Why a saved media address plays in one place and not another: ask for it the
// several ways a browser might, and print what the site answers to each.
//
//   node probe-media.mjs <media address> [the page it was saved from]
//
// Nothing is downloaded: each request is dropped as soon as its headers are
// in. A site that guards its media looks at who is asking (Referer, Origin,
// the Sec-Fetch headers a browser adds) or at a signature in the address that
// runs out; the lines that differ from the rest say which.
const [url, page] = process.argv.slice(2);
if (!url) { console.error('usage: node probe-media.mjs <media address> [the page it was saved from]'); process.exit(2); }
const site = page ? new URL(page).origin : new URL(url).origin;
const agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const media = { 'Sec-Fetch-Dest': 'video', 'Sec-Fetch-Mode': 'no-cors', Range: 'bytes=0-' };
const ways = [
  ['bare (no browser headers)', {}],
  ['a tab of its own (typed into the address bar)', { 'User-Agent': agent, 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' }],
  ['a <video> in the reader (another site, no Referer)', { 'User-Agent': agent, ...media, 'Sec-Fetch-Site': 'cross-site' }],
  ['a <video> on the page it came from', { 'User-Agent': agent, ...media, 'Sec-Fetch-Site': 'same-site', Referer: page || site + '/' }],
  ['the reader, if it sent that Referer', { 'User-Agent': agent, ...media, 'Sec-Fetch-Site': 'cross-site', Referer: page || site + '/' }],
];
// Follow the redirects by hand, so each step is seen.
async function ask(headers) {
  const steps = [];
  let at = url;
  for (let hop = 0; hop < 6; hop++) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000);
    let r;
    try { r = await fetch(at, { headers, redirect: 'manual', signal: ctl.signal }); }
    catch (e) { steps.push('no answer (' + (e.cause?.code || e.name) + ')'); break; }
    finally { clearTimeout(timer); }
    ctl.abort();   // the headers are enough
    const to = r.headers.get('location');
    steps.push(`${r.status} ${r.headers.get('content-type') || 'no type'} ${r.headers.get('content-length') || r.headers.get('content-range') || ''}`.trim());
    if (r.status < 300 || r.status >= 400 || !to) break;
    at = new URL(to, at).href;
    steps.push('  -> ' + (new URL(at).host === new URL(url).host ? new URL(at).pathname.slice(0, 70) : at.slice(0, 90)));
  }
  return steps;
}
const expiry = [...new URL(url).searchParams].filter(([k, v]) => /^(e|exp|expires?|oe|validto|ttl|secure)$/i.test(k) || /^\d{10}$/.test(v) || /,\d{10}$/.test(v));
if (expiry.length) {
  for (const [k, v] of expiry) {
    const secs = Number((v.match(/\d{10}/) || [])[0]), hex = /^[0-9a-f]{8}$/i.test(v) ? parseInt(v, 16) : 0, when = secs || hex;
    console.log(`the address carries "${k}=${v.slice(0, 40)}"` + (when ? `: that reads as ${new Date(when * 1000).toISOString()}${when * 1000 < Date.now() ? ', which is PAST: the address has run out' : ''}` : ''));
  }
  console.log();
}
for (const [name, headers] of ways) {
  console.log(name);
  for (const s of await ask(headers)) console.log('    ' + s);
}
console.log('\nA 200 or 206 with a video type is the media itself. A redirect to another file, a 403, or a text/html answer is the site refusing that way of asking.');
