import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { WikiStore } from '../core/index.mjs';
import * as wikiPlugin from './index.mjs';

function runtimeImport(packageName) {
  const modulesDir = process.env.DSH_WIKI_DSH_MODULES;
  if (!modulesDir) return import(packageName);
  const require = createRequire(resolve(modulesDir, '..', 'package.json'));
  return import(pathToFileURL(require.resolve(packageName)).href);
}

test('native Harness registers, executes, refreshes, and unloads the wiki tools', async () => {
  const [{ Context }, { default: SystemPrompt }, { default: Tools }] = await Promise.all([
    runtimeImport('@deepseek-ai/cordis'),
    runtimeImport('@deepseek-ai/dsh-system-prompt'),
    runtimeImport('@deepseek-ai/dsh-tools'),
  ]);
  const ctx = new Context();
  const temp = await mkdtemp(join(tmpdir(), 'dsh-wiki-native-'));
  try {
    const dataDir = join(temp, 'wiki');
    const seedPath = join(temp, 'seed.json');
    const source = {
      id: 'native-test',
      name: 'Native test documentation',
      type: 'local',
      url: 'https://example.com/native-test',
      revision: 'fixture-revision',
    };
    await writeFile(seedPath, JSON.stringify({
      version: 1,
      sources: [source],
      documents: [{
        path: 'native.md',
        markdown: '# Native Harness\n\n## Registry\n\nThe registry supports a durable platypus index.',
        sourceId: source.id,
        sourceUrl: `${source.url}/native.md`,
        sourceRevision: source.revision,
      }],
    }));

    await ctx.plugin(SystemPrompt);
    await ctx.plugin(Tools);
    const batch = typeof ctx.tools.setExecutor === 'function';
    if (batch) await ctx.plugin(await runtimeImport('@deepseek-ai/dsh-tool-executor-native'));
    const plugin = ctx.plugin(wikiPlugin, { dataDir, seedPath });
    await plugin;
    assert.deepEqual(
      ctx.tools.schemas().map(({ name }) => name).sort(),
      ['wiki_context', 'wiki_read', 'wiki_search', 'wiki_status'],
    );

    async function invoke(name, args = {}, signal = new AbortController().signal) {
      if (!batch) return ctx.tools.execute({ callId: name, name, arguments: args, signal });
      const calls = [{ type: 'tool-call', id: name, name, arguments: JSON.stringify(args) }];
      const { results } = await ctx.tools.execute({ calls, signal });
      return results[0].result;
    }

    async function call(name, args) {
      const result = await invoke(name, args);
      assert.equal(result.isError, false, result.error?.message);
      assert.equal(result.content[0].type, 'text');
      assert.deepEqual(JSON.parse(result.content[0].text), result.value);
      return result.value;
    }

    const status = await call('wiki_status');
    assert.equal(status.documentCount, 1);
    const { results } = await call('wiki_search', { query: 'platypus' });
    assert.equal(results.length, 1);
    const [{ id, sectionAnchor }] = results;
    const first = await call('wiki_read', { id, sectionAnchor, maxChars: 5 });
    assert.equal(first.nextOffset, 5);
    const rest = await call('wiki_read', { id, sectionAnchor, offset: first.nextOffset });
    assert.match(first.body + rest.body, /durable platypus index/);
    assert.equal(rest.sourceRevision, source.revision);
    assert.equal(rest.nextOffset, null);
    const pack = await call('wiki_context', { ids: [id], budget: 900 });
    assert.match(pack.markdown, /durable platypus index/);
    assert.ok(pack.markdown.includes(`${source.url}/native.md`));
    assert.ok(pack.tokenEstimate <= 900);

    const invalid = await invoke('wiki_search', { limit: 'five' });
    assert.equal(invalid.isError, true);
    assert.match(invalid.error.message, /limit/);
    const missing = await invoke('wiki_read', { id: 'missing' });
    assert.equal(missing.isError, true);
    assert.match(missing.error.message, /not found/);
    const cancelled = await invoke('wiki_status', {}, AbortSignal.abort());
    assert.equal(cancelled.isError, true);

    const writer = new WikiStore({ dataDir, seedPath });
    await writer.init();
    await writer.importDocuments([{ path: 'fresh.md', markdown: '# Fresh\n\nA new seahorse entry.' }], {
      source: { id: 'new-local', name: 'New local source', type: 'local' },
    });
    assert.equal((await call('wiki_status')).documentCount, 2);
    assert.equal((await call('wiki_search', { query: 'seahorse' })).results.length, 1);

    await plugin.dispose();
    assert.equal(ctx.tools.get('wiki_read'), undefined);
    assert.equal(ctx.tools.schemas().length, 0);
  } finally {
    await ctx.fiber.dispose();
    await rm(temp, { recursive: true, force: true });
  }
});
