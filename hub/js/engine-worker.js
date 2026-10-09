// The document engine's worker: the package's own (node_modules/marginalia-engine/dist/worker.js), message for
// message, with one thing more. `open` takes a file on this server as well as a Blob: { url, size }, read from the
// server a piece at a time by range requests, so a book is never fetched whole. Only the zip's directory and the
// chapters being read come over the network, and only a few blocks of them are held here at once.
//
// The engine reads synchronously, so the requests are synchronous too: allowed in a worker, and they never hold up
// the page. They carry the page's cookie, as any request to this server does.
import init, { lastPanic, MgDocument } from '/vendor/marginalia/wasm/marginalia_wasm.js';

let ready = null;
let wasm = null;
let doc = null;
let crashed = null;
const post = (m, t = []) => self.postMessage(m, t);

function parseError(e) {
  if (e instanceof WebAssembly.RuntimeError) {
    let why = '';
    try { why = lastPanic() ?? ''; } catch { /* the instance may be too broken to ask */ }
    crashed = { code: 'crashed', message: `The document engine stopped (${why || e.message}).` };
    return crashed;
  }
  const msg = e instanceof Error ? e.message : String(e);
  try {
    const v = JSON.parse(msg);
    if (v?.error) return v.error;
  } catch { /* not JSON */ }
  return { code: 'internal', message: msg };
}
const noDoc = () => new Error('{"error":{"code":"invalid","message":"no document open"}}');

async function load() {
  // A failed load (offline, or a newer page with a newer engine) is tried again on the next request.
  ready ??= init({ module_or_path: '/vendor/marginalia/wasm/marginalia_wasm_bg.wasm' }).catch((e) => {
    ready = null;
    throw new Error(JSON.stringify({ error: { code: 'stale_build', message: `The document engine could not load (${e instanceof Error ? e.message : e}).` } }));
  });
  wasm = await ready;
}

// Reads of a Blob (a file on this device), straight into the engine's buffer, as the package does.
function blobReader(file) {
  const fr = new FileReaderSync();
  return {
    read(offset, buffer) {
      let got;
      try { got = new Uint8Array(fr.readAsArrayBuffer(file.slice(offset, offset + buffer.length))); }
      catch (e) { throw `the file can no longer be read (${e instanceof Error ? e.name : String(e)})`; }
      if (got.length !== buffer.length) throw 'the file changed while it was being read';
      buffer.set(got);
    },
  };
}

// Bytes `from` to `to` (inclusive) of a file on the server. The server may send fewer than asked for (it sends at most
// a few megabytes to one request); what came is returned, and the caller asks again for the rest.
function fetchRange(url, from, to) {
  const x = new XMLHttpRequest();
  x.open('GET', url, false);
  x.responseType = 'arraybuffer';
  x.setRequestHeader('Range', `bytes=${from}-${to}`);
  try { x.send(); } catch (e) { throw `the server could not be reached (${e instanceof Error ? e.name : String(e)})`; }
  if (x.status === 206) return new Uint8Array(x.response);
  if (x.status === 200) return new Uint8Array(x.response).subarray(from, to + 1);   // a server that sends the whole file
  throw `the server answered ${x.status}`;
}
// How long the file is: from the answer to a request for its first byte.
function sizeOf(url) {
  const x = new XMLHttpRequest();
  x.open('GET', url, false);
  x.responseType = 'arraybuffer';
  x.setRequestHeader('Range', 'bytes=0-0');
  try { x.send(); } catch (e) { throw `the server could not be reached (${e instanceof Error ? e.name : String(e)})`; }
  const total = /\/(\d+)\s*$/.exec(x.getResponseHeader('Content-Range') || '');
  if (x.status === 206 && total) return Number(total[1]);
  if (x.status === 200) return x.response.byteLength;
  throw `the server answered ${x.status}`;
}

// Reads of a file on the server. The engine asks for small pieces, often one straight after another (a zip entry's
// header, then its data), so a small read fetches the whole block of 64 KB it falls in, and the last eight blocks are
// kept: a chapter is then a request or two. A read of a block's size or more goes straight into the engine's buffer,
// and the last such read, if it is no larger than 256 KB, is kept too: the first is the end of the zip, where its
// directory, its package file and its contents also are. What is held here stays under 800 KB, whatever the file's size.
const BLOCK = 64 << 10, KEEP = 8, SPAN = 256 << 10;
function rangeReader(url, size) {
  const blocks = new Map();   // block number -> its bytes, the one used last at the end
  let span = null;            // the last large read: { offset, bytes }
  const block = (n) => {
    let b = blocks.get(n);
    if (b) { blocks.delete(n); blocks.set(n, b); return b; }
    const from = n * BLOCK, to = Math.min(size, from + BLOCK) - 1;
    b = new Uint8Array(to - from + 1);
    fill(from, b);
    blocks.set(n, b);
    if (blocks.size > KEEP) blocks.delete(blocks.keys().next().value);
    return b;
  };
  const fill = (offset, buffer) => {
    for (let done = 0; done < buffer.length;) {
      const got = fetchRange(url, offset + done, offset + buffer.length - 1);
      if (!got.length) throw 'the file ended early';
      buffer.set(got.subarray(0, buffer.length - done), done);
      done += got.length;
    }
  };
  return {
    read(offset, buffer) {
      if (offset + buffer.length > size) throw 'a read past the end of the file';
      if (span && offset >= span.offset && offset + buffer.length <= span.offset + span.bytes.length) {
        buffer.set(span.bytes.subarray(offset - span.offset, offset - span.offset + buffer.length));
        return;
      }
      if (buffer.length >= BLOCK) {
        fill(offset, buffer);
        if (buffer.length <= SPAN) span = { offset, bytes: buffer.slice() };
        return;
      }
      for (let done = 0; done < buffer.length;) {
        const at = offset + done, n = Math.floor(at / BLOCK), b = block(n), from = at - n * BLOCK;
        const take = Math.min(buffer.length - done, b.length - from);
        buffer.set(b.subarray(from, from + take), done);
        done += take;
      }
    },
  };
}

self.onmessage = async (ev) => {
  const r = ev.data;
  try {
    if (crashed) { post({ id: r.id, ok: false, error: crashed }); return; }
    await load();
    switch (r.op) {
      case 'open': {
        doc?.free();
        doc = null;
        const f = r.file;
        if (f && typeof f.url === 'string') {
          const size = f.size ?? sizeOf(f.url);
          doc = MgDocument.openSource(size, rangeReader(f.url, size), r.password, r.fingerprint);
        } else if (typeof FileReaderSync === 'function') {
          doc = MgDocument.openSource(f.size, blobReader(f), r.password, r.fingerprint);
        } else {
          doc = new MgDocument(new Uint8Array(await f.arrayBuffer()), r.password);
        }
        post({ id: r.id, ok: true, result: JSON.parse(doc.call('summary', '')) });
        return;
      }
      case 'call':
        if (!doc) throw noDoc();
        post({ id: r.id, ok: true, result: JSON.parse(doc.call(r.method, r.args)) });
        return;
      case 'memory':
        post({ id: r.id, ok: true, result: wasm?.memory.buffer.byteLength ?? 0 });
        return;
      case 'geometry': {
        if (!doc) throw noDoc();
        const g = doc.geometry(r.unit);
        post({ id: r.id, ok: true, result: g }, [g.buffer]);
        return;
      }
      case 'resource': {
        if (!doc) throw noDoc();
        const res = doc.resource(r.path);
        const bytes = res.bytes, mediaType = res.mediaType;
        res.free();
        post({ id: r.id, ok: true, result: { bytes, mediaType } }, [bytes.buffer]);
        return;
      }
    }
  } catch (e) {
    post({ id: r.id, ok: false, error: parseError(e) });
  }
};
