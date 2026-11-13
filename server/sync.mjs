import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './config.mjs';

export async function syncSource(store, { config, fetchImpl = fetch, signal } = {}) {
  config ??= JSON.parse(await readFile(path.join(ROOT, 'data/source-config.json'), 'utf8'));
  const { repository, ref, paths } = config;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[\w./-]+$/.test(ref) || !Array.isArray(paths) || !paths.length || paths.length > 200) {
    throw Object.assign(new Error('Invalid source configuration.'), { code: 'INVALID_INPUT' });
  }
  for (const item of paths) {
    if (!item.path?.endsWith('.md') || item.path.startsWith('/') || item.path.split('/').some(s => s === '..' || s === '.')) {
      throw Object.assign(new Error('Invalid source document path.'), { code: 'INVALID_INPUT' });
    }
  }
  const get = async (url, json = false) => {
    const controllerSignal = AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]);
    const response = await fetchImpl(url, { signal: controllerSignal, headers: { Accept: json ? 'application/vnd.github+json' : 'text/plain', 'User-Agent': 'dsh-wiki/0.1' }, redirect: 'error' });
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);
    if (Number(response.headers.get('content-length')) > 1024 * 1024) throw new Error('Source document exceeds 1 MiB.');
    const body = await response.text();
    if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('Source document exceeds 1 MiB.');
    return json ? JSON.parse(body) : body;
  };
  try {
    const head = await get(`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref)}`, true);
    if (!/^[a-f0-9]{40}$/i.test(head.sha)) throw new Error('Source did not return an immutable commit.');
    const at = new Date().toISOString();
    const documents = new Array(paths.length);
    let cursor = 0;
    // All requested files belong to one immutable commit. Persist only after every read succeeds.
    await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
      while (cursor < paths.length) {
        const index = cursor++;
        const spec = paths[index];
        const sourcePath = spec.path.split('/').map(encodeURIComponent).join('/');
        const markdown = await get(`https://raw.githubusercontent.com/${repository}/${head.sha}/${sourcePath}`);
        if (!markdown.trim() || /^\s*<!doctype html/i.test(markdown)) throw new Error(`Invalid Markdown for ${spec.path}.`);
        const tags = spec.tags ?? [spec.language === 'zh' ? '中文' : 'English', 'DSH', ...(spec.path.includes('tool') ? ['tools'] : []), ...(spec.path.includes('plugin') || spec.path.includes('develop') ? ['plugins'] : [])];
        documents[index] = { ...spec, markdown, sourceId: config.id, sourceUrl: `https://github.com/${repository}/blob/${head.sha}/${sourcePath}`, sourceRevision: head.sha, fetchedAt: at, verifiedAt: at, tags };
      }
    }));
    signal?.throwIfAborted();
    const result = await store.importDocuments(documents, {
      source: { id: config.id, name: config.name, type: 'github', url: `https://github.com/${repository}`, revision: head.sha, checkedAt: at, license: config.license }, replace: true,
    });
    return { ...result, revision: head.sha, checkedAt: at, documentCount: documents.length };
  } catch (error) {
    throw Object.assign(new Error(`同步未完成，现有知识库已保留。${error.message}`), { code: 'SYNC_FAILED', cause: error });
  }
}
