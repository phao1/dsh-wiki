import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildContextPack } from './context.mjs';
import { diffLines } from './diff.mjs';
import { buildDocument, connectDocuments, documentSummary, invalidInput, isRecord, metadataText, sourceDate } from './documents.mjs';
import { createSearchIndex, searchIndex } from './search.mjs';

const queues = new Map();
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const emptySeed = { version: 1, sources: [], documents: [] };
const defaultSourceId = 'local';

function compareDocuments(a, b) {
  return collator.compare(a.title, b.title) || collator.compare(a.path, b.path) || a.id.localeCompare(b.id);
}

function nonnegativeInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < 0) throw invalidInput(`${name} must be a non-negative integer.`);
  return value;
}

function sourceId(value, fallback = defaultSourceId) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) throw invalidInput('Source ID must be a non-empty string.');
  return value.trim();
}

function normalizeSource(id, raw = {}, previous = {}) {
  const type = metadataText(raw.type) ?? previous.type ?? 'local';
  return {
    id,
    name: metadataText(raw.name) ?? previous.name ?? (id === defaultSourceId ? 'Local Markdown' : id),
    type,
    url: metadataText(raw.url) ?? previous.url ?? null,
    revision: metadataText(raw.revision) ?? previous.revision ?? null,
    checkedAt: sourceDate(raw.checkedAt) ?? previous.checkedAt ?? null,
    ...(metadataText(raw.license ?? previous.license) ? { license: metadataText(raw.license ?? previous.license) } : {}),
  };
}

function latestSourceTime(sources, documents) {
  const now = Date.now();
  let latest = null;
  for (const date of [...sources.map(source => source.checkedAt), ...documents.flatMap(({ fetchedAt, verifiedAt }) => [fetchedAt, verifiedAt])]) {
    if (date && Date.parse(date) <= now && (latest === null || date > latest)) latest = date;
  }
  return latest;
}

function createSnapshot({ version, sources, documents, history, diffs, lastUpdated }) {
  const sorted = connectDocuments([...documents].sort(compareDocuments));
  return {
    version, sources, documents: sorted, history, diffs, lastUpdated,
    byId: new Map(sorted.map(document => [document.id, document])),
    search: createSearchIndex(sorted),
  };
}

function loadSnapshot(raw) {
  if (!isRecord(raw) || !Number.isSafeInteger(raw.version) || raw.version < 1 || !Array.isArray(raw.sources) || !Array.isArray(raw.documents)) {
    throw new Error('Invalid wiki state or seed.');
  }
  const sources = new Map();
  for (const source of raw.sources) {
    if (!isRecord(source) || !source.id) throw new Error('Invalid source in wiki state or seed.');
    const id = sourceId(source.id);
    if (sources.has(id)) throw new Error(`Duplicate source in wiki state or seed: ${id}`);
    sources.set(id, normalizeSource(id, source));
  }

  const documents = new Map();
  for (const document of raw.documents) {
    const id = sourceId(document?.sourceId);
    if (!sources.has(id)) sources.set(id, normalizeSource(id));
    const normalized = buildDocument(document, sources.get(id));
    if (documents.has(normalized.id)) throw new Error(`Duplicate document in wiki state or seed: ${normalized.path}`);
    documents.set(normalized.id, normalized);
  }

  const history = raw.history ?? [];
  const diffEntries = raw.diffs ?? [];
  if (!Array.isArray(history) || !history.every(batch => isRecord(batch) && Array.isArray(batch.changes)) || !Array.isArray(diffEntries)) {
    throw new Error('Invalid change history in wiki state.');
  }
  const diffs = new Map();
  for (const entry of diffEntries) {
    if (!isRecord(entry) || typeof entry.documentId !== 'string' || typeof entry.title !== 'string'
      || ![entry.before, entry.after].every(value => value === null || typeof value === 'string')) {
      throw new Error('Invalid diff in wiki state.');
    }
    diffs.set(entry.documentId, entry);
  }
  const sourceList = [...sources.values()];
  const documentList = [...documents.values()];
  return createSnapshot({
    version: raw.version, sources: sourceList, documents: documentList, history, diffs,
    lastUpdated: sourceDate(raw.lastUpdated) ?? latestSourceTime(sourceList, documentList),
  });
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${file}.`, { cause: error });
    throw error;
  }
}

async function writeSnapshot(dataDir, statePath, snapshot) {
  const { version, sources, documents, history, diffs, lastUpdated } = snapshot;
  const serialized = JSON.stringify({
    version, sources, documents: documents.map(document => document.record), history,
    diffs: [...diffs.values()], lastUpdated,
  });
  await mkdir(dataDir, { recursive: true });
  const temporary = join(dataDir, `.state-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${serialized}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, statePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function serializeWrites(key, operation) {
  const prior = queues.get(key) ?? Promise.resolve();
  const pending = prior.then(operation, operation);
  queues.set(key, pending);
  const clear = () => { if (queues.get(key) === pending) queues.delete(key); };
  pending.then(clear, clear);
  return pending;
}

function fold(value) {
  return metadataText(value)?.normalize('NFKC').toLowerCase() ?? null;
}

function filterDocuments(documents, options) {
  const category = fold(options.category);
  const tag = fold(options.tag);
  const language = fold(options.language);
  const source = typeof options.sourceId === 'string' ? options.sourceId.trim() : null;
  return documents.filter(document => (!category || fold(document.category) === category)
    && (!tag || document.tags.some(value => fold(value) === tag))
    && (!language || fold(document.language) === language)
    && (!source || document.sourceId === source));
}

function facets(values) {
  const counts = new Map();
  for (const name of values) {
    const key = fold(name);
    const facet = counts.get(key);
    if (facet) facet.count++;
    else counts.set(key, { name, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || collator.compare(a.name, b.name));
}

function documentChanged(before, after) {
  return before.hash !== after.hash || before.title !== after.title || before.category !== after.category
    || before.language !== after.language || JSON.stringify(before.tags) !== JSON.stringify(after.tags);
}

function recordChange(group, diffs, type, before, after) {
  const { id: documentId, title } = after ?? before;
  group[type]++;
  group.changes.push({ documentId, title, type, beforeHash: before?.hash ?? null, afterHash: after?.hash ?? null });
  diffs.set(documentId, { documentId, title, before: before?.record.markdown ?? null, after: after?.record.markdown ?? null });
}

function applyImport(snapshot, inputs, source, replace) {
  if (!Array.isArray(inputs)) throw invalidInput('documents must be an array.');
  if (source !== undefined && !isRecord(source)) throw invalidInput('source must be an object.');
  if (typeof replace !== 'boolean') throw invalidInput('replace must be a boolean.');
  const requestedSource = source ? sourceId(source.id) : replace && inputs.length ? sourceId(inputs[0]?.sourceId) : null;
  if (replace && !requestedSource) throw invalidInput('Replacing a source with no documents requires its source ID.');

  const sources = new Map(snapshot.sources.map(source => [source.id, source]));
  const documents = new Map(snapshot.byId);
  const diffs = new Map(snapshot.diffs);
  const groups = new Map();
  const seen = new Set();
  let dirty = false;

  const groupFor = id => {
    if (!groups.has(id)) {
      const previous = sources.get(id);
      const metadata = normalizeSource(id, id === requestedSource ? source : undefined, previous);
      dirty ||= JSON.stringify(metadata) !== JSON.stringify(previous);
      sources.set(id, metadata);
      groups.set(id, { sourceId: id, added: 0, changed: 0, unchanged: 0, removed: 0, changes: [] });
    }
    return groups.get(id);
  };
  if (requestedSource) groupFor(requestedSource);
  for (const input of inputs) {
    const id = sourceId(input?.sourceId, requestedSource ?? defaultSourceId);
    if (requestedSource && id !== requestedSource) throw invalidInput(`Document source ${id} differs from the import source ${requestedSource}.`);
    const group = groupFor(id);
    const after = buildDocument(input, sources.get(id));
    if (seen.has(after.id)) throw invalidInput(`Duplicate document path in source ${id}: ${after.path}`);
    seen.add(after.id);

    const before = documents.get(after.id);
    if (!before) recordChange(group, diffs, 'added', null, after);
    else if (documentChanged(before, after)) recordChange(group, diffs, 'changed', before, after);
    else group.unchanged++;
    dirty ||= JSON.stringify(before?.record) !== JSON.stringify(after.record);
    documents.set(after.id, after);
  }

  if (replace) {
    const group = groups.get(requestedSource);
    for (const document of snapshot.documents) {
      if (document.sourceId !== requestedSource || seen.has(document.id)) continue;
      dirty = true;
      recordChange(group, diffs, 'removed', document, null);
      documents.delete(document.id);
    }
  }

  const at = new Date().toISOString();
  const version = snapshot.version + Number(dirty);
  const changes = [];
  const history = [];
  const result = { added: 0, changed: 0, unchanged: 0, removed: 0, version, changes };
  for (const group of groups.values()) {
    for (const key of ['added', 'changed', 'unchanged', 'removed']) result[key] += group[key];
    changes.push(...group.changes);
    if (group.changes.length) {
      const { unchanged, ...batch } = group;
      history.push({ id: randomUUID(), at, ...batch });
    }
  }

  const next = dirty ? createSnapshot({
    version, sources: [...sources.values()], documents: [...documents.values()],
    history: [...history, ...snapshot.history], diffs, lastUpdated: at,
  }) : snapshot;
  return { next, result };
}

export class WikiStore {
  #dataDir;
  #statePath;
  #seedPath;
  #snapshot;
  #initializing;

  constructor({ dataDir, seedPath } = {}) {
    if (typeof dataDir !== 'string' || !dataDir.trim()) throw invalidInput('A data directory is required.');
    this.#dataDir = resolve(dataDir);
    this.#statePath = join(this.#dataDir, 'state.json');
    this.#seedPath = seedPath;
  }

  async #persisted() {
    try {
      return await readJson(this.#statePath);
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async init() {
    if (!this.#initializing) {
      this.#initializing = (async () => {
        const stored = await this.#persisted();
        const raw = stored === undefined ? (this.#seedPath ? await readJson(this.#seedPath) : emptySeed) : stored;
        this.#snapshot = loadSnapshot(raw);
        return this;
      })();
    }
    try {
      return await this.#initializing;
    } catch (error) {
      this.#initializing = undefined;
      throw error;
    }
  }

  #state() {
    if (!this.#snapshot) throw new Error('Call WikiStore.init() before reading.');
    return this.#snapshot;
  }

  status() {
    const snapshot = this.#state();
    const now = Date.now();
    const freshness = { fresh: 0, stale: 0, unverified: 0 };
    const sourceCounts = new Map();
    let sectionCount = 0;
    for (const document of snapshot.documents) {
      const summary = documentSummary(document, now);
      freshness[summary.status]++;
      sourceCounts.set(document.sourceId, (sourceCounts.get(document.sourceId) ?? 0) + 1);
      sectionCount += document.sectionCount;
    }
    return {
      documentCount: snapshot.documents.length, sectionCount,
      sources: snapshot.sources.map(source => ({ ...source, documentCount: sourceCounts.get(source.id) ?? 0 })),
      categories: facets(snapshot.documents.map(document => document.category)),
      tags: facets(snapshot.documents.flatMap(document => document.tags)),
      languages: facets(snapshot.documents.map(document => document.language)),
      freshness, lastUpdated: snapshot.lastUpdated, version: snapshot.version,
    };
  }

  listDocuments(options = {}) {
    const limit = nonnegativeInteger(options.limit, 100, 'limit');
    const offset = nonnegativeInteger(options.offset, 0, 'offset');
    const documents = filterDocuments(this.#state().documents, options);
    const now = Date.now();
    return { total: documents.length, documents: documents.slice(offset, offset + limit).map(document => documentSummary(document, now)) };
  }

  search(query, options = {}) {
    if (typeof query !== 'string') throw invalidInput('query must be a string.');
    const limit = nonnegativeInteger(options.limit, 20, 'limit');
    const offset = nonnegativeInteger(options.offset, 0, 'offset');
    const snapshot = this.#state();
    const documents = filterDocuments(snapshot.documents, options);
    const matches = query.trim() ? searchIndex(snapshot.search, query, new Set(documents.map(document => document.id)))
      : documents.map(({ id, excerpt }) => ({ id, score: 0, snippet: excerpt, sectionAnchor: null, sectionTitle: null, matchedTerms: [] }));
    const now = Date.now();
    return {
      query, total: matches.length,
      results: matches.slice(offset, offset + limit).map(match => ({ ...documentSummary(snapshot.byId.get(match.id), now), ...match })),
    };
  }

  getDocument(id) {
    const document = this.#state().byId.get(id);
    if (!document) return null;
    const { body, sections, links, backlinks } = document;
    return { ...documentSummary(document, Date.now()), body, ...structuredClone({ sections, links, backlinks }) };
  }

  contextPack({ query = '', ids = [], budget = 4000 } = {}) {
    if (typeof query !== 'string') throw invalidInput('query must be a string.');
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string' && id.trim())) throw invalidInput('ids must be an array of non-empty strings.');
    budget = nonnegativeInteger(budget, 4000, 'budget');
    const snapshot = this.#state();
    const warnings = [];
    const candidates = [];
    if (ids.length) {
      for (const id of new Set(ids)) {
        const document = snapshot.byId.get(id);
        if (document) candidates.push({ document });
        else warnings.push(`Document ${id} was not found.`);
      }
    } else if (query.trim()) {
      for (const match of searchIndex(snapshot.search, query, new Set(snapshot.byId.keys()))) {
        candidates.push({ ...match, document: snapshot.byId.get(match.id) });
      }
      if (!candidates.length) warnings.push('No documents matched the query.');
    } else {
      warnings.push('Provide a query or document IDs to build a context pack.');
    }
    return buildContextPack(candidates, budget, warnings);
  }

  async importDocuments(documents, { source, replace = false } = {}) {
    await this.init();
    return serializeWrites(this.#statePath, async () => {
      const stored = await this.#persisted();
      if (stored !== undefined && stored?.version !== this.#snapshot.version) this.#snapshot = loadSnapshot(stored);
      const { next, result } = applyImport(this.#snapshot, documents, source, replace);
      if (next !== this.#snapshot) {
        await writeSnapshot(this.#dataDir, this.#statePath, next);
        this.#snapshot = next;
      }
      return structuredClone(result);
    });
  }

  history() {
    return structuredClone(this.#state().history);
  }

  diff(documentId) {
    const entry = this.#state().diffs.get(documentId);
    if (!entry) return null;
    return { ...entry, changes: diffLines(entry.before, entry.after) };
  }
}
