import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dsh = process.env.DSH_WIKI_DSH_BIN || 'dsh';
const exec = promisify(execFile);
const home = await mkdtemp(join(tmpdir(), 'dsh-wiki-host-'));
const env = {
  ...process.env,
  DSH_HOME: home,
  DSH_WIKI_DATA_DIR: join(home, 'wiki-data'),
  DEEPSEEK_API_KEY: '',
};

const smokePlugin = `
export const name = 'wiki-host-smoke';
export const inject = ['tools', 'loader'];

export function apply(ctx) {
  let started = false;

  async function check() {
    if (started || !ctx.tools.get('wiki_status')) return;
    started = true;
    const signal = new AbortController().signal;
    const batch = typeof ctx.tools.setExecutor === 'function';

    async function call(name, args = {}) {
      const id = 'wiki-host-' + name;
      let result;
      if (batch) {
        const calls = [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }];
        ({ result } = (await ctx.tools.execute({ calls, signal })).results[0]);
      } else {
        result = await ctx.tools.execute({ callId: id, name, arguments: args, signal });
      }
      if (result.isError) throw new Error(result.error.message);
      return result.value;
    }

    try {
      await ctx.loader.await();
      const status = await call('wiki_status');
      const search = await call('wiki_search', { query: 'Cordis' });
      const read = await call('wiki_read', { id: search.results[0].id, maxChars: 256 });
      const pack = await call('wiki_context', { ids: [read.id], budget: 900 });
      console.error('DSH_WIKI_HOST_RESULT ' + JSON.stringify({
        documents: status.documentCount,
        matches: search.total,
        title: read.title,
        source: read.sourceUrl,
        citations: pack.documents.length,
        citesSource: pack.markdown.includes(read.sourceUrl),
      }));
    } catch (error) {
      console.error('DSH_WIKI_HOST_ERROR ' + error.message);
    }
  }

  ctx.on('tools/change', check);
  void check();
}
`;

try {
  const overlay = join(home, 'smoke.patch.yml');
  await Promise.all([
    writeFile(overlay, '- insert:\n    - id: wiki-host-smoke\n      name: ./smoke.mjs\n'),
    writeFile(join(home, 'smoke.mjs'), smokePlugin),
  ]);
  const { stdout: version } = await exec(dsh, ['--version'], { cwd: root, env, timeout: 30_000 });
  await exec(dsh, ['plugin', '--profile', 'sdk-minimal', 'add', root], {
    cwd: root,
    env,
    timeout: 45_000,
  });

  const host = spawn(dsh, ['sdk-minimal', '--patch', overlay], { cwd: root, env });
  const timeout = setTimeout(() => host.kill('SIGKILL'), 20_000);
  let stdout = '';
  let stderr = '';
  let outcome;
  let inputError;
  host.stdin.on('error', (error) => { inputError = error; });
  host.stdout.setEncoding('utf8').on('data', (text) => { stdout += text; });
  host.stderr.setEncoding('utf8').on('data', (text) => {
    stderr += text;
    if (outcome) return;
    outcome = /^DSH_WIKI_HOST_(RESULT|ERROR) (.+)\n/m.exec(stderr);
    if (outcome) {
      host.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'shutdown', params: {} }) + '\n');
    }
  });

  try {
    const [exitCode, signal] = await once(host, 'close');
    assert.equal(exitCode, 0, `SDK host exited with ${exitCode ?? signal}.\n${stderr}`);
    assert.equal(inputError, undefined);
    assert.equal(outcome?.[1], 'RESULT', stderr);
    assert.deepEqual(JSON.parse(stdout.trim()), { jsonrpc: '2.0', id: 1, result: {} });

    const report = JSON.parse(outcome[2]);
    assert.ok(report.documents > 0);
    assert.ok(report.matches > 0);
    assert.match(report.source, /^https:\/\/github\.com\/deepseek-ai\/deepseek-harness\/blob\//);
    assert.equal(report.citations, 1);
    assert.equal(report.citesSource, true);
    console.log(`DeepSeek Harness ${version.trim()} verified four wiki tools and clean SDK shutdown.`);
    console.log(JSON.stringify(report));
  } finally {
    clearTimeout(timeout);
  }
} finally {
  await rm(home, { recursive: true, force: true });
}
