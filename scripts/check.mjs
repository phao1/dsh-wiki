import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT } from '../server/config.mjs';

const files = [];
async function walk(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { if (entry.name.startsWith('.') || entry.name === 'node_modules') continue; const p = path.join(dir, entry.name); if (entry.isDirectory()) await walk(p); else if (/\.[cm]?js$/.test(entry.name)) files.push(p); } }
for (const dir of ['packages', 'server', 'cli', 'web', 'scripts']) await walk(path.join(ROOT, dir));
let failures = 0;
for (const file of files) { const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }); if (result.status !== 0) { console.error(result.stderr); failures++; } }
console.log(`Syntax check: ${files.length} JavaScript files; ${failures} failures.`);
process.exitCode = failures ? 1 : 0;
