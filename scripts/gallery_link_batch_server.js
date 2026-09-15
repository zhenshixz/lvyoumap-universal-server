const { draftView } = require('./gallery_trip_discovery');
const http = require('http');
const C = require('./gallery_link_batch_common');
const { fs, path, root, runtime, draft, read, write, validateDraft, batchList, batchPath, alive, sourcePolicy } = C;
const service = 'gallery-link-batch-v1';
const actions = require('./gallery_link_batch_actions');
let mutating = false;
const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
function local(req) { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress); }
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST') {
      const port = server.address().port;
      const allowed = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
      if (!local(req) || !allowed.includes(req.headers.origin) || !allowed.includes(`http://${req.headers.host}`) || !req.headers['content-type']?.startsWith('application/json')) return json(res, { error: '请在本机清单网页保存' }, 403);
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) return json(res, { error: '清单请求超过8MB' }, 413); chunks.push(chunk); }
      if (mutating) return json(res, { error: '正在处理上一个操作，请稍候' }, 409);
      mutating = true;
      try {
        const input = JSON.parse(Buffer.concat(chunks));
        if (url.pathname === '/api/start') return json(res, await actions.start(input));
        if (url.pathname === '/api/retry-transient') return json(res, await actions.retryTransient(input));
        if (url.pathname === '/api/resume-ip') return json(res, await actions.resumeIp(input));
        if (url.pathname === '/api/apply') return json(res, await actions.apply(input));
        let next;
        if (url.pathname === '/api/remaining') next = actions.remaining(input);
        else if (url.pathname === '/api/draft') next = actions.saveDraft(input);
        else if (url.pathname === '/api/generate') next = actions.generate(input);
        else if (url.pathname === '/api/restore') next = actions.restore(input);
        else return json(res, { error: 'Not found' }, 404);
        return json(res, { ...draftView(next), sourcePolicy: sourcePolicy(), remainingCount: actions.pool().length, readOnly: false });
      } finally { mutating = false; }
    }
    if (req.method !== 'GET') return json(res, { error: 'Method not allowed' }, 405);
    if (url.pathname === '/api/health') return json(res, { service, root });
    if (url.pathname === '/api/draft') return json(res, { ...draftView(draft()), sourcePolicy: sourcePolicy(), remainingCount: actions.pool().length, readOnly: !local(req) });
    if (url.pathname === '/api/batches') return json(res, batchList());
    if (url.pathname === '/api/drafts') return json(res, actions.draftList());
    if (url.pathname === '/api/batch') {
      const s = read(path.join(batchPath(url.searchParams.get('id')), 'state.json'));
      if (!s) return json(res, { error: '批次不存在' }, 404);
      if (s.status === 'running' && !alive(s.pid)) s.status = 'interrupted';
      const { existingMap, imagesOf } = require('./gallery_existing_images');
      const { classify } = require('./gallery_retry_policy');
      const existing = existingMap();
      return json(res, { ...s, retryableCount:s.items.filter(i=>classify(i)==='retry' && !(i.images||[]).some(im=>im.accepted)).length,
        items:s.items.map(i=>({...i, existingImages:imagesOf(existing.get(i.id)), existingCover:existing.get(i.id)?.image})), apply: actions.receipt(s.id), readOnly: !local(req) });
    }
    let file, type;
    if (url.pathname === '/') { file = path.join(__dirname, 'gallery-link-batch.html'); type = 'text/html; charset=utf-8'; }
    else if (url.pathname === '/ui.js') { file = path.join(__dirname, 'gallery_link_batch_ui.js'); type = 'text/javascript; charset=utf-8'; }
    else if (url.pathname === '/vue.js') { file = require.resolve('vue/dist/vue.global.prod.js'); type = 'text/javascript; charset=utf-8'; }
    else {
      const m = url.pathname.match(/^\/media\/(\d{8}-\d{6}-[a-f0-9]{6})\/(thumbs|candidates)\/(amap_[A-Za-z0-9]+-(?:trip|amap)-[a-f0-9]{16}\.jpg)$/);
      if (m) { file = path.join(batchPath(m[1]), m[2], m[3]); type = 'image/jpeg'; }
    }
    if (!file || !fs.existsSync(file)) return json(res, { error: 'Not found' }, 404);
    res.writeHead(200, { 'Content-Type': type }); fs.createReadStream(file).pipe(res);
  } catch (e) { json(res, { error: e.message }, 400); }
});
(async () => {
  draft();
  for (let port = 4210; port < 4220; port++) {
    const ok = await new Promise((resolve, reject) => {
      const fail = e => { server.removeListener('listening', done); if (e.code === 'EADDRINUSE') resolve(false); else reject(e); };
      const done = () => { server.removeListener('error', fail); resolve(true); };
      server.once('error', fail); server.once('listening', done); server.listen(port, '0.0.0.0');
    });
    if (ok) { write(path.join(runtime, 'server.json'), { pid: process.pid, port, service, root }); return; }
  }
  throw Error('No available port 4210-4219');
})().catch(e => { console.error(e.message); process.exit(1); });
