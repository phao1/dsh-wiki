import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { Agent, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { duplexPair } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createServer, startServer } from '../server/index.mjs';
import { renderMarkdown, safeURL } from '../web/markdown.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../cli/wiki.mjs', import.meta.url));
const digest = text => createHash('sha256').update(text).digest('hex');

async function tempLibrary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-wiki-e2e-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, dataDir: join(directory, 'store') };
}

async function openWorkbench(t, options) {
  let server, url, agent;
  try {
    ({ server, url } = await startServer({ ...options, port: 0 }));
    assert.equal(server.address().address, '127.0.0.1');
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    t.diagnostic('Loopback socket denied. Node HTTP client and server parsers run over in-memory streams.');
    ({ server } = await createServer(options));
    url = 'http://127.0.0.1:4310';
    agent = new Agent({ keepAlive: false });
    agent.createConnection = () => {
      const [peer, socket] = duplexPair();
      server.emit('connection', peer);
      return socket;
    };
  }
  const close = async () => {
    agent?.destroy();
    if (server.listening) await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  };
  t.after(close);
  return {
    close,
    send(path, { body, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      return new Promise((resolve, reject) => {
        const req = request(url, {
          path, method, agent,
          headers: {
            ...(payload === undefined ? {} : {
              Origin: url, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
            }),
            ...headers,
          },
        }, res => {
          res.setEncoding('utf8');
          let text = '';
          res.on('data', chunk => { text += chunk; });
          res.on('error', reject);
          res.on('end', () => resolve({
            status: res.statusCode, headers: res.headers, text,
            json: () => JSON.parse(text),
          }));
        });
        req.on('error', reject);
        req.end(payload);
      });
    },
  };
}

const zhPath = 'runbook.zh.md';
const enPath = 'runbook.en.md';
const zhSource = 'https://example.test/dsh/runbook.zh.md';
const enSource = 'https://example.test/dsh/runbook.en.md';
const importedSource = { id: 'acceptance-runbook', name: 'Acceptance runbook', type: 'local' };
const zh = [
  '---', 'title: 灰度发布手册', 'language: zh', `source_url: ${zhSource}`,
  'fetched_at: "2024-01-10T12:00:00Z"', 'tags: [release, 回滚]', '---', '',
  '# 灰度发布手册', '', '## 回滚审批', '',
  '紧急灰度回滚需要值班人员审批。旧阈值为三分钟。',
  '', '[英文手册](runbook.en.md)', '',
].join('\n');
const en = [
  '---', 'language: en', `source_url: ${enSource}`, 'tags: [release]', '---', '',
  '# Release Runbook', '', '## Rollback approval', '',
  'Canary rollback requires incident commander approval.', '',
  ...Array.from({ length: 60 }, (_, n) =>
    `Step ${n + 1}: Record the deployment identifier and ask the on-call operator to confirm the result.`), '',
].join('\n');

test('CLI Markdown import and HTTP workbench share durable documents, citations, and diffs', { timeout: 30_000 }, async t => {
  const { directory, dataDir } = await tempLibrary(t);
  const run = async (...args) => (await exec(process.execPath, [cli, ...args, '--data-dir', dataDir], { timeout: 12_000 })).stdout;
  const first = await openWorkbench(t, { dataDir });
  const home = await first.send('/');
  assert.equal(home.status, 200);
  assert.match(home.headers['content-type'], /^text\/html/);
  const initial = (await first.send('/api/status')).json();
  assert.ok(initial.documentCount > 0, 'The standard startup must load the bundled corpus.');
  await first.close();

  const filename = join(directory, zhPath);
  await writeFile(filename, zh);
  const imported = JSON.parse(await run('import', filename, '--source-id', importedSource.id,
    '--source-name', importedSource.name, '--json'));
  assert.equal(imported.added, 1);
  const diskBefore = await readFile(join(dataDir, 'state.json'), 'utf8');
  assert.ok(diskBefore.includes('紧急灰度回滚'));

  const second = await openWorkbench(t, { dataDir });
  const addEnglish = await second.send('/api/import', {
    body: { source: importedSource, documents: [{ path: enPath, markdown: en }] },
  });
  assert.equal(addEnglish.status, 200, addEnglish.text);
  assert.equal(addEnglish.json().added, 1);
  await second.close();

  const third = await openWorkbench(t, { dataDir });
  const postRestart = (await third.send('/api/status')).json();
  assert.equal(postRestart.documentCount, initial.documentCount + 2);
  const query = (q, language) => `/api/search?${new URLSearchParams({ q, language, sourceId: importedSource.id })}`;
  const [chinese, english] = await Promise.all([
    third.send(query('回滚审批', 'zh')), third.send(query('canary rollback', 'en')),
  ]);
  assert.equal(chinese.status, 200, chinese.text);
  assert.equal(english.status, 200, english.text);
  const [hitZh] = chinese.json().results;
  const [hitEn] = english.json().results;
  assert.equal(hitZh.path, zhPath);
  assert.equal(hitEn.path, enPath);
  assert.equal(hitZh.sectionTitle, '回滚审批');
  assert.match(hitEn.snippet, /canary rollback/i);

  const read = id => third.send(`/api/document?id=${encodeURIComponent(id)}`);
  const full = (await read(hitZh.id)).json();
  assert.equal(full.sourceUrl, zhSource);
  assert.equal(full.hash, digest(zh));
  assert.equal(full.status, 'stale');
  assert.equal(hitEn.status, 'unverified');
  assert.ok(full.sections.some(section => section.anchor === hitZh.sectionAnchor));
  assert.ok(full.links.some(link => link.id === hitEn.id));
  assert.ok((await read(hitEn.id)).json().backlinks.some(link => link.id === hitZh.id));
  const raw = await run('read', hitZh.id);
  assert.ok(raw.includes(`Source: ${zhSource}`));
  assert.ok(raw.includes(`SHA-256: ${full.hash}`));
  assert.ok(raw.includes(full.body));
  const cliSearch = JSON.parse(await run('search', 'canary rollback', '--language', 'en', '--json'));
  assert.equal(cliSearch.results[0].id, hitEn.id);

  const context = await third.send('/api/context', {
    body: { query: 'canary rollback', ids: [hitEn.id], budget: 220 },
  });
  assert.equal(context.status, 200, context.text);
  const pack = context.json();
  assert.ok(pack.tokenEstimate > 0 && pack.tokenEstimate <= 220);
  assert.equal(pack.truncated, true);
  assert.equal(pack.documents[0].sourceUrl, enSource);
  assert.ok(pack.markdown.includes(enSource));
  assert.ok(pack.markdown.includes(hitEn.hash));
  assert.match(await run('context', 'canary rollback', '--ids', hitEn.id, '--budget', '220'), /approximately \d+\/220 tokens/);

  const revised = zh.replace('旧阈值为三分钟', '新阈值为五分钟');
  const update = await third.send('/api/import', {
    body: { source: importedSource, documents: [{ path: zhPath, markdown: revised }] },
  });
  assert.equal(update.status, 200, update.text);
  assert.equal(update.json().changed, 1);
  const manifest = await third.send('/api/export?format=manifest');
  assert.match(manifest.headers['content-disposition'], /attachment.*manifest\.json/);
  assert.ok(manifest.json().documents.some(doc => doc.id === hitZh.id && doc.hash === digest(revised)));
  await third.close();

  const fourth = await openWorkbench(t, { dataDir });
  const diff = (await fourth.send(`/api/diff?id=${hitZh.id}`)).json();
  assert.ok(diff.changes.some(line => line.type === 'removed' && line.text.includes('旧阈值为三分钟')));
  assert.ok(diff.changes.some(line => line.type === 'added' && line.text.includes('新阈值为五分钟')));
  const history = (await fourth.send('/api/history')).json();
  assert.ok(history.some(batch => batch.changes.some(change =>
    change.documentId === hitZh.id && change.beforeHash === full.hash && change.afterHash === digest(revised))));
});

test('GitHub sync pins every read and a partially failed replacement preserves state', { timeout: 20_000 }, async t => {
  const { dataDir } = await tempLibrary(t);
  const repository = 'fixture-org/fixture-docs';
  const syncConfig = {
    id: 'dsh-official', name: 'GitHub fixture', repository, ref: 'master',
    paths: [{ path: 'intro.en.md', language: 'en' }, { path: 'intro.zh.md', language: 'zh' }],
  };
  const firstSha = 'a'.repeat(40), secondSha = 'b'.repeat(40);
  let revision = firstSha;
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url === `https://api.github.com/repos/${repository}/commits/master`) return Response.json({ sha: revision });
    const prefix = `https://raw.githubusercontent.com/${repository}/${revision}/`;
    if (url === prefix + 'intro.en.md') {
      return new Response(revision === firstSha ? '# Fixture docs\n\nSaffron original revision.\n' : '# Fixture docs\n\nIndigo changed revision.\n');
    }
    if (url === prefix + 'intro.zh.md') {
      return revision === firstSha ? new Response('# 同步样例\n\n初始快照已发布。\n') : new Response('unavailable', { status: 503 });
    }
    assert.fail(`Unexpected fixture fetch: ${url}`);
  };
  const workbench = await openWorkbench(t, { dataDir, fetchImpl, syncConfig });
  const first = await workbench.send('/api/sync', { body: {} });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json().revision, firstSha);
  assert.equal(first.json().documentCount, 2);
  assert.equal(calls.length, 3);
  assert.ok(calls.slice(1).every(url => url.includes(`/${firstSha}/`)));
  const find = `/api/search?${new URLSearchParams({ q: 'saffron', sourceId: syncConfig.id })}`;
  const [before] = (await workbench.send(find)).json().results;
  assert.ok(before.sourceUrl.includes(`/blob/${firstSha}/`));
  const statePath = join(dataDir, 'state.json');
  const snapshot = await readFile(statePath, 'utf8');
  const history = (await workbench.send('/api/history')).json();

  revision = secondSha;
  const failure = await workbench.send('/api/sync', { body: {} });
  assert.equal(failure.status, 502, failure.text);
  assert.equal(failure.json().code, 'SYNC_FAILED');
  assert.equal(calls.length, 6);
  assert.ok(calls.slice(4).every(url => url.includes(`/${secondSha}/`)));
  assert.equal(await readFile(statePath, 'utf8'), snapshot);
  assert.deepEqual((await workbench.send('/api/history')).json(), history);
  assert.equal((await workbench.send(find)).json().results[0].hash, before.hash);
  assert.equal((await workbench.send('/api/status')).json().lastSync.ok, false);
  await workbench.close();
  const restarted = await openWorkbench(t, { dataDir });
  assert.equal((await restarted.send(find)).json().results[0].hash, before.hash);
});

test('HTTP rejects foreign writes, rebinding Hosts and filesystem escapes without persisting them', { timeout: 15_000 }, async t => {
  const { dataDir } = await tempLibrary(t);
  const workbench = await openWorkbench(t, { dataDir });
  const body = { source: importedSource, documents: [{ path: 'guard.md', markdown: '# Guard fixture\n' }] };
  assert.equal((await workbench.send('/api/import', { body })).status, 200);
  const statePath = join(dataDir, 'state.json');
  const before = await readFile(statePath, 'utf8');
  for (const [headers, status] of [
    [{ Origin: 'https://untrusted.example' }, 403],
    [{ 'Sec-Fetch-Site': 'cross-site' }, 403],
    [{ Host: 'rebinding.example:4310' }, 403],
    [{ 'Content-Type': 'text/plain' }, 415],
  ]) {
    const result = await workbench.send('/api/import', { body, headers });
    assert.equal(result.status, status, result.text);
  }
  assert.equal((await workbench.send('/api/status', { headers: { Host: 'rebinding.example' } })).status, 403);
  for (const url of ['/%2e%2e%2fserver%2findex.mjs', '/..%5cserver%5cindex.mjs']) {
    const result = await workbench.send(url);
    assert.equal(result.status, 404, result.text);
    assert.doesNotMatch(result.text, /export async function createServer/);
  }
  const escape = await workbench.send('/api/import', {
    body: {
      source: importedSource, replace: true,
      documents: [...body.documents, { path: '../outside.md', markdown: '# Outside\n' }],
    },
  });
  assert.equal(escape.status, 400, escape.text);
  assert.equal(await readFile(statePath, 'utf8'), before);
});

test('HTTP and CLI keep the reserved official source immutable to local imports', { timeout: 15_000 }, async t => {
  const { directory, dataDir } = await tempLibrary(t);
  const workbench = await openWorkbench(t, { dataDir });
  const docs = [{ path: 'bad.md', markdown: '# Local document\n' }];
  const status = (await workbench.send('/api/status')).json();
  const officialBefore = status.sources.find(source => source.id === 'dsh-official');
  assert.ok(officialBefore?.documentCount > 0);
  for (const id of ['dsh-official', ' dsh-official ']) {
    const result = await workbench.send('/api/import', {
      body: { source: { id }, documents: docs, replace: true },
    });
    assert.equal(result.status, 403, result.text);
  }
  await workbench.close();
  const file = join(directory, 'bad.md');
  await writeFile(file, docs[0].markdown);
  const run = (target, source) => exec(process.execPath, [
    cli, 'import', target, '--source-id', source, '--replace', '--data-dir', dataDir,
  ], { timeout: 10_000 });
  await assert.rejects(run(file, ' dsh-official '), error => error.code === 1 && /official source/i.test(error.stderr));
  const link = join(directory, 'symlink.md');
  await symlink(file, link);
  await assert.rejects(run(link, 'local'), error => error.code === 1 && /symbolic-link/i.test(error.stderr));
  const restarted = await openWorkbench(t, { dataDir });
  assert.deepEqual((await restarted.send('/api/status')).json().sources.find(source => source.id === 'dsh-official'), officialBefore);
});

test('Untrusted source and markup remain inert at presentation boundaries', { timeout: 15_000 }, async t => {
  const { dataDir } = await tempLibrary(t);
  const workbench = await openWorkbench(t, { dataDir });
  const hostileUrl = 'javascript:alert(1)';
  const html = '<img src=x onerror=alert(1)>';
  const hostileCategory = '<iframe src=x>';
  const bad = '# Hostile fixture\n\n' + html +
    '\n\n[unsafe link](JaVaScRiPt:alert(1))\n\n[safe link](https://example.test/)\n';
  const result = await workbench.send('/api/import', {
    body: {
      source: importedSource,
      documents: [{ path: 'hostile.md', markdown: bad, sourceUrl: hostileUrl, category: hostileCategory }],
    },
  });
  assert.equal(result.status, 200, result.text);
  const list = (await workbench.send(`/api/documents?sourceId=${importedSource.id}`)).json();
  const response = await workbench.send(`/api/document?id=${list.documents[0].id}`);
  assert.equal(response.status, 200, response.text);
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.match(response.headers['content-security-policy'], /script-src 'self'/);
  const document = response.json();
  assert.ok(document.body.includes(html), 'The JSON API must preserve the original Markdown body.');
  assert.equal(safeURL(document.sourceUrl), null);
  assert.equal(safeURL('data:text/html,<script>alert(1)</script>'), null);
  const index = await workbench.send('/api/export?format=index');
  assert.equal(index.status, 200, index.text);
  assert.doesNotMatch(index.text, /javascript:alert/);
  assert.ok(!index.text.includes(hostileCategory), 'Exported index metadata must not contain raw HTML.');

  const createNode = tag => ({
    tag, children: [], dataset: {},
    get textContent() { return this.text ?? this.children.map(node => node.textContent ?? node.text).join(''); },
    set textContent(text) { this.text = text; },
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this[name] = value; },
    set innerHTML(_html) { assert.fail('Raw HTML must never enter the Markdown DOM sink.'); },
  });
  const previous = globalThis.document;
  globalThis.document = {
    createElement: createNode,
    createDocumentFragment: () => createNode('#fragment'),
    createTextNode: text => ({ tag: '#text', text, children: [] }),
  };
  try {
    const tree = renderMarkdown(document.body, { sections: document.sections, hideTitle: document.title });
    const walk = node => [node, ...node.children.flatMap(walk)];
    const nodes = walk(tree);
    assert.ok(nodes.some(node => node.tag === '#text' && node.text.includes(html)));
    assert.ok(nodes.every(node => !['script', 'img', 'iframe'].includes(node.tag)));
    assert.deepEqual(nodes.filter(node => node.tag === 'a').map(node => node.href), ['https://example.test/']);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});
