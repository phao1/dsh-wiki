import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WikiStore } from '../packages/core/index.mjs';
import { parseMarkdown } from '../packages/core/markdown.mjs';
import { seedPath } from '../server/config.mjs';
import { exportCorpus } from '../server/export-corpus.mjs';

async function fixture(t, seed) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new WikiStore({ dataDir: join(root, 'data'), seedPath: seed });
  await store.init();
  return { root, store };
}

const loadJson = async path => JSON.parse(await readFile(path, 'utf8'));

test('exports an indexed Markdown snapshot with stable paths and two verifiable hashes', async t => {
  const { root, store } = await fixture(t);
  const sourceUrl = 'https://example.test/guide';
  const lastModified = '2024-01-23T12:00:00.000Z';
  await store.importDocuments([
    {
      path: 'docs/guide (v1).md', sourceUrl, sourceRevision: 'revision-1',
      markdown: `---\ntitle: "<script>Guide</script>"\nlast_modified: ${lastModified}\n---\n# Guide\n\n[More](./more.md)\n`,
      category: '<img src=x>', language: 'en', tags: ['工具', 'CLI'],
    },
    { path: 'docs/more.md', markdown: '# More\n\nContinued text without a final newline.' },
  ], { source: { id: 'local' } });
  await store.importDocuments([{ path: 'docs/guide (v1).md', markdown: '# Other guide', sourceUrl: 'javascript:alert(1)' }], {
    source: { id: 'other' },
  });

  const outputDir = join(root, 'snapshot');
  assert.deepEqual(await exportCorpus(store, outputDir), { outputDir, documentCount: 3, fileCount: 10 });
  assert.deepEqual((await readdir(outputDir)).sort(), ['INDEX.md', 'NOTICE.md', 'TAGS.md', 'crossrefs.json', 'documents', 'llms.txt', 'manifest.json', 'tags.json']);
  const manifest = await loadJson(join(outputDir, 'manifest.json'));
  assert.equal(manifest.version, store.status().version);
  for (const entry of manifest.documents) {
    const bytes = await readFile(join(outputDir, entry.exportPath));
    const parsed = parseMarkdown(bytes.toString('utf8'));
    const document = store.getDocument(entry.id);
    assert.equal(parsed.body, document.body);
    assert.equal(parsed.frontmatter.source_hash, document.hash);
    assert.equal(entry.hash, document.hash);
    assert.equal(entry.exportSha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(entry.exportPath, `documents/${document.sourceId}/${document.path}`);
  }
  const guide = manifest.documents.find(document => document.sourceUrl === sourceUrl);
  const metadata = parseMarkdown(await readFile(join(outputDir, guide.exportPath), 'utf8')).frontmatter;
  assert.equal(metadata.last_modified, lastModified);
  assert.equal(metadata.source_revision, 'revision-1');
  assert.equal(guide.status, 'unverified');
  assert.equal(guide.lastModified, lastModified);
  assert.deepEqual(metadata.tags, ['工具', 'CLI']);

  const index = await readFile(join(outputDir, 'INDEX.md'), 'utf8');
  assert.ok(index.includes('documents/local/docs/guide%20%28v1%29.md'));
  assert.ok(index.includes(sourceUrl));
  assert.ok(!index.includes('<script>'));
  assert.ok(!index.includes('<img src=x>'));
  assert.ok(!index.includes('javascript:'));
  const tags = await loadJson(join(outputDir, 'tags.json'));
  assert.equal(tags['工具'][0].exportPath, guide.exportPath);
  const refs = await loadJson(join(outputDir, 'crossrefs.json'));
  assert.equal(refs[guide.id].links[0].exportPath, 'documents/local/docs/more.md');
  assert.equal(refs[refs[guide.id].links[0].id].backlinks[0].id, guide.id);
  const llms = await readFile(join(outputDir, 'llms.txt'), 'utf8');
  assert.ok(llms.includes('Continued text without a final newline.'));
  assert.ok(llms.includes(guide.hash));
});

test('exports the official corpus with its bundled MIT text', async t => {
  const { root, store } = await fixture(t, seedPath);
  const outputDir = join(root, 'official');
  const result = await exportCorpus(store, outputDir);
  assert.equal(result.documentCount, store.status().documentCount);
  assert.equal(result.fileCount, result.documentCount + 8);
  const license = await readFile(join(outputDir, 'licenses/DEEPSEEK-MIT.txt'));
  assert.deepEqual(license, await readFile(new URL('../licenses/DEEPSEEK-MIT.txt', import.meta.url)));
  const notice = await readFile(join(outputDir, 'NOTICE.md'), 'utf8');
  assert.match(notice, /licenses\/DEEPSEEK-MIT\.txt/);
  assert.match(notice, /original copyright and license terms/);
});

test('rejects every existing destination and preflights unsafe document paths', async t => {
  const { root, store } = await fixture(t);
  const dir = join(root, 'existing');
  const file = join(root, 'existing-file');
  const link = join(root, 'existing-link');
  const absent = join(root, 'absent');
  await mkdir(dir);
  await writeFile(join(dir, 'marker'), 'kept');
  await writeFile(file, 'kept');
  await symlink(absent, link);
  for (const destination of [dir, file, link]) {
    await assert.rejects(exportCorpus(store, destination), { code: 'INVALID_INPUT' });
  }
  assert.equal(await readFile(join(dir, 'marker'), 'utf8'), 'kept');
  assert.equal(await readFile(file, 'utf8'), 'kept');
  assert.ok((await lstat(link)).isSymbolicLink());
  await assert.rejects(lstat(absent), { code: 'ENOENT' });

  const invalid = { id: 'invalid', path: '../escape.md', sourceId: 'local', hash: 'x' };
  const invalidStore = {
    status: () => ({ documentCount: 1, version: 1, sources: [] }),
    listDocuments: () => ({ total: 1, documents: [invalid] }),
    getDocument: () => invalid,
  };
  await assert.rejects(exportCorpus(invalidStore, absent), { code: 'INVALID_INPUT' });
  await assert.rejects(lstat(absent), { code: 'ENOENT' });
});

test('exports legal source IDs and filenames that would collide on other file systems', async t => {
  const { root, store } = await fixture(t);
  await store.importDocuments([
    { path: 'guide.md', markdown: '# A' },
    { path: 'Guide.md', markdown: '# B' },
    { path: 'guide.md/chapter.md', markdown: '# C' },
    { path: 'guide', markdown: '# D' },
    { path: 'CON.md', markdown: '# E' },
  ], { source: { id: '../a source' } });
  const outputDir = join(root, 'portable');
  assert.equal((await exportCorpus(store, outputDir)).documentCount, 5);
  const { documents } = await loadJson(join(outputDir, 'manifest.json'));
  assert.equal(new Set(documents.map(document => document.exportPath.toLowerCase())).size, 5);
  for (const document of documents) {
    assert.match(document.exportPath, /^documents\/~[a-f0-9]{24}\/[^/]+\.md$/i);
    const parsed = parseMarkdown(await readFile(join(outputDir, document.exportPath), 'utf8'));
    assert.equal(parsed.frontmatter.path, document.path);
  }
});
