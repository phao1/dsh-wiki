import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WikiStore } from '../packages/core/index.mjs';
import { estimateTokens } from '../packages/core/markdown.mjs';

const DAY = 24 * 60 * 60 * 1000;
const time = offset => new Date(Date.now() + offset * DAY).toISOString();
const source = { id: 'sample', name: 'Sample corpus', type: 'local' };

async function testStore(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-wiki-core-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new WikiStore({ dataDir });
  await store.init();
  return { store, dataDir };
}

test('imports Markdown metadata, stable sections, and relative and absolute backlinks', async t => {
  const { store } = await testStore(t);
  const older = time(-30);
  const markdown = [
    '---', 'title: "Guide: setup #1" # YAML comment', 'category: Reference',
    "tags: ['first, pair', Tools, tools]", 'language: en', 'source_url: https://example.test/docs/guide',
    `scraped_at: ${older}`, '---', 'Intro text.', '', '# Guide', '',
    '[Path](./another%20guide.md#details)', '[Reference][setup]', '[[Setup|Wiki alias]]',
    '[External citation](https://example.test/manual#overview)', '`[Fake](hidden.md)`', '',
    '## Repeat', '```md', '## Hidden heading', '[Fake](hidden.md)', '```', '', '## Repeat',
    'Setext details', '--------------', '', '[setup]: <another guide.md>', '',
  ].join('\n');
  await store.importDocuments([
    { path: 'docs/guide.md', markdown: '\uFEFF' + markdown.replace(/\n/g, '\r\n') },
    { path: 'docs/another guide.md', markdown: '# Setup\n', fetchedAt: time(3) },
    { path: 'docs/hidden.md', markdown: '# Hidden', verifiedAt: time(-1) },
    { path: 'manual.md', markdown: '# Manual', sourceId: 'remote', sourceUrl: 'https://example.test/manual' },
  ]);
  await store.importDocuments([], { source: { ...source, id: 'local', checkedAt: time(0) } });
  const { documents } = store.listDocuments();
  const byPath = new Map(documents.map(document => [document.path, document]));
  const guide = store.getDocument(byPath.get('docs/guide.md').id);
  assert.equal(guide.title, 'Guide: setup #1');
  assert.equal(guide.category, 'Reference');
  assert.deepEqual(guide.tags, ['first, pair', 'Tools']);
  assert.equal(guide.sourceUrl, 'https://example.test/docs/guide');
  assert.equal(guide.fetchedAt, older);
  assert.equal(guide.status, 'stale');
  assert.equal(guide.hash, createHash('sha256').update(markdown).digest('hex'));
  assert.ok(guide.body.startsWith('Intro text.\n\n# Guide'));
  assert.deepEqual(guide.sections.map(section => section.anchor), ['overview', 'guide', 'repeat', 'repeat-1', 'setext-details']);
  assert.equal(guide.sections[1].startLine, 3);
  assert.equal(guide.sections[1].endLine, 10);
  assert.deepEqual(new Set(guide.links.map(({ id }) => id)), new Set([
    byPath.get('docs/another guide.md').id, byPath.get('manual.md').id,
  ]));
  for (const { id } of guide.links) assert.deepEqual(store.getDocument(id).backlinks.map(backlink => backlink.id), [guide.id]);
  assert.deepEqual(store.status().freshness, { fresh: 1, stale: 1, unverified: 2 });
  assert.equal(store.listDocuments({ tag: 'TOOLS', language: 'en' }).total, 1);
  assert.equal(store.listDocuments({ limit: '1', offset: '1' }).documents.length, 1);
  assert.equal(store.getDocument('missing'), null);
});

test('ranks English and Chinese queries and locates their matching section', async t => {
  const { store } = await testStore(t);
  await store.importDocuments([
    { path: 'tls.md', markdown: '# Network\n\nStart the daemon.\n\n## Secure transport\n\nConfigure TLS handshakes and certificate validation.', category: 'Network', tags: ['security'] },
    { path: 'tls-z.zh.md', markdown: '# 网络\n\n## 沙箱权限\n\n快速配置沙箱权限并验证策略。' },
    { path: 'sandbox.md', markdown: '# Sandbox permissions\n\nSet the policy for the sandbox and allowed actions.' },
    { path: 'other.md', markdown: '# Backup\n\nBack up local files.' },
  ], { source });
  const english = store.search('TLS handshakes').results[0];
  assert.equal(english.path, 'tls.md');
  assert.equal(english.sectionAnchor, 'secure-transport');
  assert.match(english.snippet, /TLS handshakes/);
  assert.ok(english.matchedTerms.includes('handshakes'));
  const chinese = store.search('快速配置沙箱', { language: 'zh' }).results[0];
  assert.equal(chinese.sectionAnchor, '沙箱权限');
  assert.match(chinese.snippet, /快速配置沙箱/);
  const translated = store.search('如何设置沙箱权限', { language: 'en' }).results[0];
  assert.equal(translated.path, 'sandbox.md');
  assert.ok(translated.matchedTerms.includes('sandbox'));
  assert.equal(store.search('TLS', { tag: 'security', limit: 1 }).total, 1);
  assert.equal(store.search('TLS', { limit: 0 }).results.length, 0);
  assert.equal(store.search('  ', { category: 'network' }).results[0].score, 0);
  assert.equal(store.search('unmatchableword').total, 0);
});

test('packs relevant sections with complete citations under the approximate budget', async t => {
  const { store } = await testStore(t);
  const url = 'https://example.test/guide.md';
  await store.importDocuments([
    { path: 'guide.md', sourceUrl: url, markdown: `# Guide\n\nUnused introduction.\n\n## Certificate rotation\n\nRotate with the new key. ${'密钥 😀 '.repeat(180)}` },
    { path: 'local.md', sourceUrl: 'javascript:alert(1)', markdown: '# Local\n\nCreate a local backup.' },
  ], { source });
  const { documents } = store.listDocuments();
  const guide = documents.find(document => document.path === 'guide.md');
  const pack = store.contextPack({ query: 'certificate rotation', budget: 250 });
  assert.equal(pack.documents[0].id, guide.id);
  assert.match(pack.markdown, /guide\.md#certificate-rotation/);
  assert.match(pack.markdown, /Section: Certificate rotation · lines 5–7/);
  assert.match(pack.markdown, /Rotate with the new key/);
  assert.match(pack.markdown, /Token count is approximate/);
  assert.ok(pack.markdown.includes(guide.hash));
  assert.ok(!pack.markdown.includes('Unused introduction'));
  assert.equal(pack.truncated, true);
  assert.ok(pack.warnings.length);

  const ids = [...documents.map(({ id }) => id), 'missing'];
  for (const budget of [0, 1, 30, 80, 110, 140, 180, 300, 500, 1_600]) {
    const result = store.contextPack({ ids, budget });
    assert.equal(result.tokenEstimate, estimateTokens(result.markdown));
    assert.ok(result.tokenEstimate <= budget);
    assert.ok(result.warnings.some(warning => warning.includes('missing')));
    for (const document of result.documents) assert.ok(result.markdown.includes(document.hash));
    assert.ok(!result.markdown.includes('javascript:'));
  }
  assert.equal(store.contextPack({ ids, budget: 0 }).markdown, '');
  assert.equal(store.contextPack({ query: 'unmatchableword' }).documents.length, 0);
  assert.throws(() => store.contextPack({ budget: -1 }), { code: 'INVALID_INPUT' });
});

test('persists changes, diffs, freshness-only checks, and source-scoped removals', async t => {
  const { store, dataDir } = await testStore(t);
  const first = '# Widget\n\nOld instructions.\n\nKeep this line.\n';
  const second = first.replace('Old instructions.', 'New instructions.');
  await store.importDocuments([
    { path: 'docs/widget.md', markdown: first, fetchedAt: time(-30) },
    { path: 'obsolete.md', markdown: '# Obsolete\n' },
  ], { source: { ...source, revision: 'old' } });
  await store.importDocuments([{ path: 'docs/widget.md', markdown: '# External\n' }], { source: { id: 'external' } });
  const local = store.listDocuments({ sourceId: source.id }).documents;
  const widget = local.find(document => document.path === 'docs/widget.md');
  const obsolete = local.find(document => document.path === 'obsolete.md');
  const result = await store.importDocuments([{ path: 'docs/widget.md', markdown: second, fetchedAt: time(-20) }], {
    source: { ...source, revision: 'new' }, replace: true,
  });
  assert.deepEqual([result.added, result.changed, result.unchanged, result.removed], [0, 1, 0, 1]);
  assert.equal(store.getDocument(widget.id).sourceRevision, 'new');
  assert.equal(store.getDocument(obsolete.id), null);
  assert.equal(store.listDocuments({ sourceId: 'external' }).total, 1);
  const diff = store.diff(widget.id);
  assert.equal(diff.before, first);
  assert.equal(diff.after, second);
  assert.ok(diff.changes.some(line => line.type === 'removed' && line.text === 'Old instructions.'));
  assert.ok(diff.changes.some(line => line.type === 'added' && line.text === 'New instructions.'));
  assert.ok(diff.changes.some(line => line.type === 'same' && line.text === 'Keep this line.'));
  assert.equal(store.diff(obsolete.id).after, null);

  const checkedAt = time(0);
  const refreshed = await store.importDocuments([{ path: 'docs/widget.md', markdown: second, fetchedAt: checkedAt }], {
    source: { ...source, revision: 'new', checkedAt }, replace: true,
  });
  assert.equal(refreshed.unchanged, 1);
  assert.equal(refreshed.changed, 0);
  assert.equal(store.getDocument(widget.id).status, 'fresh');
  assert.equal(store.getDocument(widget.id).hash, result.changes[0].afterHash);
  assert.equal(store.history().length, 3);
  assert.deepEqual(store.history()[0].changes, result.changes);
  assert.deepEqual(store.diff(widget.id), diff);

  const reopened = new WikiStore({ dataDir });
  await reopened.init();
  assert.deepEqual(reopened.status(), store.status());
  assert.deepEqual(reopened.diff(widget.id), diff);
  assert.deepEqual(reopened.history(), store.history());
  assert.deepEqual(await readdir(dataDir), ['state.json']);
});

test('serializes writes across instances and preserves state on failed validation', async t => {
  const { store, dataDir } = await testStore(t);
  const parallel = new WikiStore({ dataDir });
  await parallel.init();
  await store.importDocuments([{ path: 'kept.md', markdown: '# Kept' }], { source });
  const before = await readFile(join(dataDir, 'state.json'), 'utf8');
  await assert.rejects(store.importDocuments([
    { path: 'would-write.md', markdown: '# Valid so far' },
    { path: '../escape.md', markdown: '# Invalid path' },
  ], { source, replace: true }), { code: 'INVALID_INPUT' });
  assert.equal(await readFile(join(dataDir, 'state.json'), 'utf8'), before);
  assert.equal(store.status().documentCount, 1);

  const results = await Promise.allSettled([
    store.importDocuments([{ path: 'a.md', markdown: '# A' }], { source }),
    store.importDocuments([{ path: 'duplicate.md', markdown: '# First' }, { path: './duplicate.md', markdown: '# Second' }], { source }),
    parallel.importDocuments([{ path: 'b.md', markdown: '# B' }], { source }),
    store.importDocuments([{ path: 'c.md', markdown: '# C' }], { source }),
  ]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
  assert.deepEqual(store.listDocuments().documents.map(({ path }) => path), ['a.md', 'b.md', 'c.md', 'kept.md']);
  assert.equal(store.history().length, 4);
  assert.deepEqual(await readdir(dataDir), ['state.json']);
});
