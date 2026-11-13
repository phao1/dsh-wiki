#!/usr/bin/env node
import path from 'node:path';
import { readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { WikiStore } from '../packages/core/index.mjs';
import { defaultDataDir, seedPath } from '../server/config.mjs';
import { syncSource } from '../server/sync.mjs';
import { exportCorpus } from '../server/export-corpus.mjs';
import { exportKnowledge } from '../server/export.mjs';

const args = process.argv.slice(2); const command = args.shift() || 'help';
const options = {}; const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) { const key = args[i].slice(2); options[key] = ['json', 'replace', 'help'].includes(key) ? true : args[++i]; }
  else positional.push(args[i]);
}
const help = `DSH Wiki — source-traceable knowledge, locally available\n\nUsage: node cli/wiki.mjs <command> [options]\n\n  serve                           Open the workbench on localhost:4310\n  status [--json]                  Document coverage and freshness\n  search <query> [--json]          Search both Chinese and English documents\n  read <document-id> [--json]      Read the source and exact indexed body\n  context <query> --budget 4000    Export a citation-bearing context pack\n  import <directory-or-file>       Import Markdown; re-import records a diff\n  sync                            Check the configured official GitHub source\n  export --format manifest        manifest | index | crossrefs | llms\n  export --format markdown --out <new-directory>\n                                   Export portable Markdown and indexes\n  doctor                          Check the environment and data snapshot\n\nCommon: --data-dir <path>, --out <file>\nSearch: --category <name>, --language zh|en, --limit 20\nImport: --source-id <id>, --source-name <name>, --replace\nContext: --ids <comma-separated-ids>, --budget <approximate-tokens>\n\nNo API key, install step, or external model is required.\nStop the workbench before a CLI import/sync targeting its data directory.\n`;

async function collectMarkdown(input) {
  const abs = path.resolve(input); const stat = await lstat(abs);
  if (stat.isSymbolicLink()) throw new Error('Symbolic-link imports are not supported. Choose the source directory itself.');
  const root = stat.isDirectory() ? abs : path.dirname(abs); const docs = [];
  async function walk(filename) {
    const st = await lstat(filename); if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const entry of await readdir(filename, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        await walk(path.join(filename, entry.name));
      }
    } else if (/\.md$/i.test(filename)) {
      if (st.size > 1024 * 1024) throw new Error(`Document exceeds 1 MiB: ${path.basename(filename)}`);
      docs.push({ path: path.relative(root, filename).split(path.sep).join('/'), markdown: await readFile(filename, 'utf8') });
    }
  }
  await walk(abs);
  if (!docs.length) throw new Error('No Markdown (.md) files found.');
  if (docs.length > 10000) throw new Error('Import at most 10,000 documents per batch.');
  return docs;
}

async function main() {
  if (command === 'help' || options.help) return process.stdout.write(help);
  if (command === 'serve') { const { startServer } = await import('../server/index.mjs'); const { url } = await startServer({ dataDir: options['data-dir'] || defaultDataDir(), port: Number(options.port || 4310) }); console.log(`DSH Wiki ready at ${url}`); return; }
  const store = new WikiStore({ dataDir: options['data-dir'] || defaultDataDir(), seedPath }); await store.init();
  let result;
  if (command === 'status') result = await store.status();
  else if (command === 'search') result = await store.search(positional.join(' '), { category: options.category, language: options.language, limit: options.limit ? Number(options.limit) : 20 });
  else if (command === 'read') { result = await store.getDocument(positional[0]); if (!result) throw new Error('Document not found. Use search to obtain an ID.'); }
  else if (command === 'context') result = await store.contextPack({ query: positional.join(' '), ids: options.ids ? options.ids.split(',') : [], budget: Number(options.budget || 4000) });
  else if (command === 'import') {
    if (!positional[0]) throw new Error('Provide a Markdown file or directory.');
    const sourceId = (options['source-id'] || 'local-import').trim(); if (sourceId === 'dsh-official') throw new Error('Use sync for the official source.');
    result = await store.importDocuments(await collectMarkdown(positional[0]), { source: { id: sourceId, name: options['source-name'] || path.basename(path.resolve(positional[0])), type: 'local' }, replace: options.replace === true });
  } else if (command === 'sync') result = await syncSource(store);
  else if (command === 'export') {
    if (options.format === 'markdown') {
      const exported = await exportCorpus(store, options.out);
      process.stdout.write(JSON.stringify(exported, null, 2) + '\n');
      return;
    }
    result = (await exportKnowledge(store, options.format || 'manifest')).body;
  }
  else if (command === 'doctor') { const status = await store.status(); result = { ok: status.documentCount > 0, node: process.version, dataDir: path.resolve(options['data-dir'] || defaultDataDir()), documents: status.documentCount, snapshot: status.version, runtimeDependencies: 0, nativePlugin: 'Run npm run test:dsh with an available DSH runtime; see docs/dsh-integration.md.' }; }
  else throw new Error(`Unknown command: ${command}. Run with help.`);
  let output;
  if (typeof result === 'string') output = result;
  else if (!options.json && command === 'read') output = `# ${result.title}\nSource: ${result.sourceUrl || 'local (no external URL)'}\nSHA-256: ${result.hash}\nFetched: ${result.fetchedAt || 'unknown'}\n\n${result.body}\n`;
  else if (!options.json && command === 'context') output = result.markdown + `\n\n<!-- approximately ${result.tokenEstimate}/${result.budget} tokens; ${result.warnings.join('; ')} -->\n`;
  else if (!options.json && command === 'search') output = `${result.total} results for “${result.query}”\n\n` + result.results.map(d => `${d.title}\n  id: ${d.id}\n  ${d.sourceUrl || 'local'}\n  ${d.snippet}\n`).join('\n');
  else output = JSON.stringify(result, null, 2) + '\n';
  if (options.out) { await writeFile(path.resolve(options.out), output); console.log(`Written: ${path.resolve(options.out)}`); }
  else process.stdout.write(output);
}
main().catch(error => { console.error(`DSH Wiki: ${error.message}`); process.exitCode = 1; });
