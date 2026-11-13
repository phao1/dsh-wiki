import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { WikiStore } from '../packages/core/index.mjs';
import { ROOT, defaultDataDir, seedPath } from './config.mjs';
import { syncSource } from './sync.mjs';
import { exportKnowledge } from './export.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const fail = (message, statusCode = 400, code = 'INVALID_INPUT') => Object.assign(new Error(message), { statusCode, code });

async function readJson(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw fail('Content-Type must be application/json.', 415);
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 8 * 1024 * 1024) throw fail('Import exceeds 8 MiB. Use the CLI for a larger corpus.', 413); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; }
  catch { throw fail('Request body must be a JSON object.'); }
}

export async function createServer({ dataDir = defaultDataDir(), seed = seedPath, fetchImpl, syncConfig } = {}) {
  const store = new WikiStore({ dataDir, seedPath: seed }); await store.init();
  let syncRunning = false, lastSync = null;
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const host = req.headers.host || '';
      if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) throw fail('Only loopback Host headers are accepted.', 403, 'FORBIDDEN');
      let url;
      try { url = new URL(req.url, `http://${host}`); } catch { throw fail('Malformed request URL.'); }
      const query = Object.fromEntries(url.searchParams);
      const json = (value, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if ((origin && origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') throw fail('Cross-origin writes are not allowed.', 403, 'FORBIDDEN');
        const body = await readJson(req);
        if (url.pathname === '/api/context') return json(await store.contextPack(body));
        if (url.pathname === '/api/import') {
          if (!Array.isArray(body.documents) || !body.documents.length) throw fail('Choose at least one Markdown document.');
          if (body.source !== undefined && (!body.source || typeof body.source !== 'object' || Array.isArray(body.source))) throw fail('source must be a JSON object.');
          const isOfficial = value => typeof value === 'string' && value.trim() === 'dsh-official';
          if (isOfficial(body.source?.id) || body.documents.some(d => isOfficial(d?.sourceId))) throw fail('The bundled official source can only be changed through sync.', 403, 'FORBIDDEN');
          return json(await store.importDocuments(body.documents, { source: { id: 'local-import', name: '本地 Markdown', ...body.source, type: 'local' }, replace: body.replace === true }));
        }
        if (url.pathname === '/api/sync') {
          if (syncRunning) throw fail('A source check is already running.', 409, 'BUSY');
          syncRunning = true;
          try { const result = await syncSource(store, { config: syncConfig, fetchImpl }); lastSync = { at: new Date().toISOString(), ok: true, ...result }; return json(result); }
          catch (error) { lastSync = { at: new Date().toISOString(), ok: false, error: error.message }; throw error; }
          finally { syncRunning = false; }
        }
        throw fail('API route not found.', 404, 'NOT_FOUND');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw fail('Method not allowed.', 405);
      if (url.pathname === '/api/status') return json({ ...await store.status(), syncRunning, lastSync });
      if (url.pathname === '/api/documents') return json(await store.listDocuments(query));
      if (url.pathname === '/api/search') return json(await store.search(query.q || '', query));
      if (url.pathname === '/api/document') { const doc = await store.getDocument(query.id); if (!doc) throw fail('Document not found.', 404, 'NOT_FOUND'); return json(doc); }
      if (url.pathname === '/api/history') return json(await store.history());
      if (url.pathname === '/api/diff') { const diff = await store.diff(query.id); if (!diff) throw fail('No previous version is available for this document.', 404, 'NOT_FOUND'); return json(diff); }
      if (url.pathname === '/api/export') { const out = await exportKnowledge(store, query.format); res.writeHead(200, { 'Content-Type': out.contentType, 'Content-Disposition': `attachment; filename="${out.filename}"`, 'Cache-Control': 'no-store' }); return res.end(out.body); }
      if (url.pathname.startsWith('/api/')) throw fail('API route not found.', 404, 'NOT_FOUND');
      let relative;
      try { relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1); } catch { throw fail('Malformed file path.'); }
      if (!relative || relative.includes('..') || relative.includes('\\') || relative.includes('\0') || !MIME[path.extname(relative)] || relative.startsWith('.')) throw fail('File not found.', 404, 'NOT_FOUND');
      const fullPath = path.join(ROOT, 'web', relative);
      let content; try { content = await readFile(fullPath); } catch { throw fail('File not found.', 404, 'NOT_FOUND'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(relative)], 'Cache-Control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const code = error.statusCode || (error.code === 'SYNC_FAILED' ? 502 : error.code === 'INVALID_INPUT' ? 400 : 500);
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: code === 500 ? 'The request failed. The knowledge base has been preserved.' : error.message, code: error.code || 'INTERNAL_ERROR' }));
      if (code === 500) console.error(error);
    }
  });
  server.requestTimeout = 120000;
  return { server, store };
}

export async function startServer({ port = Number(process.env.PORT || 4310), ...options } = {}) {
  const { server, store } = await createServer(options);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, store, url: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer().then(({ server, url }) => {
    console.log(`DSH Wiki ready at ${url}\nData: ${defaultDataDir()}\nPress Ctrl+C to stop.`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(() => process.exit(0)); server.closeIdleConnections(); });
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
