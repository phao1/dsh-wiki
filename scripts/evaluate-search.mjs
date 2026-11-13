import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WikiStore } from '../packages/core/index.mjs';
import { seedPath } from '../server/config.mjs';

// Hand-curated bilingual smoke set, not a general retrieval benchmark.
const cases = [
  ['创建工具', ['docs/cookbook/adding-a-tool.md', 'docs/user/develop/basic/tool.md']],
  ['插件配置', ['docs/user/develop/basic/config.md']],
  ['MCP记忆', ['docs/user/guide/mcp-memory.md']],
  ['模型供应商', ['docs/user/guide/providers.md']],
  ['网络代理', ['docs/user/guide/network-proxy.md']],
  ['发布插件', ['docs/user/develop/basic/publish.md']],
  ['会话生命周期', ['docs/agent-lifecycle.md']],
  ['并行工具', ['docs/subsystems/tools.md']],
];
const dataDir = await mkdtemp(path.join(tmpdir(), 'dsh-wiki-eval-'));
try {
  const store = new WikiStore({ dataDir, seedPath }); await store.init();
  const checks = [];
  for (const [query, expected] of cases) {
    const { results } = await store.search(query, { language: 'en', limit: 5 });
    checks.push({ query, expected, hitAt5: results.some(d => expected.includes(d.path)), paths: results.map(d => d.path) });
  }
  console.log(JSON.stringify({ description: '8 curated Chinese queries against the bundled English documents. Lexical bilingual expansion; not a general-quality benchmark.', passed: checks.filter(c => c.hitAt5).length, total: checks.length, checks }, null, 2));
  process.exitCode = checks.every(c => c.hitAt5) ? 0 : 1;
} finally { await rm(dataDir, { recursive: true, force: true }); }
