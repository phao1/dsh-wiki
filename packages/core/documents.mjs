import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { estimateTokens, normalizeMarkdown, parseMarkdown, plainText } from './markdown.mjs';

const freshnessWindow = 14 * 24 * 60 * 60 * 1000;
const words = new Intl.Segmenter(undefined, { granularity: 'word' });
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function invalidInput(message) {
  return Object.assign(new Error(message), { code: 'INVALID_INPUT' });
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function metadataText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() || null : null;
}

export function sourceDate(value) {
  if (typeof value !== 'string' || !/^(?:\d{4}-\d\d-\d\d(?:[T ]|$)|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), )/.test(value)) return null;
  // Date.parse normalizes invalid ISO days, so validate the calendar date separately.
  if (/^\d/.test(value)) {
    const day = value.slice(0, 10);
    const midnight = new Date(`${day}T00:00:00Z`);
    if (!Number.isFinite(+midnight) || !midnight.toISOString().startsWith(day)) return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function documentPath(value) {
  const path = typeof value === 'string' ? value.trim().replace(/\\/g, '/') : '';
  if (!path || /^(?:\/|[A-Za-z]:)|[\0\r\n]/.test(path) || path.endsWith('/')) {
    throw invalidInput('Each document needs a relative file path.');
  }
  const normalized = posix.normalize(path);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw invalidInput(`Document path leaves its source: ${path}`);
  }
  return normalized;
}

function inferLanguage(path, text) {
  const suffix = /\.(zh(?:-[a-z]+)?|en(?:-[a-z]+)?|ja|ko)\.[^.\/]+$/i.exec(path);
  if (suffix) return suffix[1].toLowerCase();
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'ja';
  if (/\p{Script=Hangul}/u.test(text)) return 'ko';
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if (han > 0 && han / (han + latin) >= 0.14) return 'zh';
  return latin ? 'en' : 'und';
}

function normalizeTags(tags) {
  const values = Array.isArray(tags) ? tags : (metadataText(tags)?.split(',') ?? []);
  const seen = new Set();
  return values.map(metadataText).filter(value => {
    if (!value) return false;
    const key = value.normalize('NFKC').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function excerptOf(text) {
  let count = 0;
  for (const { index } of graphemes.segment(text)) {
    if (count++ === 180) return `${text.slice(0, index)}…`;
  }
  return text;
}

export function buildDocument(raw, source) {
  if (!isRecord(raw) || typeof raw.markdown !== 'string') throw invalidInput('Each document needs Markdown text.');
  const path = documentPath(raw.path);
  const markdown = normalizeMarkdown(raw.markdown);
  const { frontmatter, body, title: heading, sections, targets } = parseMarkdown(markdown);
  const text = plainText(body);
  const title = metadataText(raw.title) ?? metadataText(frontmatter.title) ?? heading
    ?? sections.find(section => section.title && section.title !== 'Overview')?.title ?? posix.basename(path, posix.extname(path));
  const language = metadataText(raw.language ?? frontmatter.language ?? frontmatter.lang);
  const tags = normalizeTags(raw.tags ?? frontmatter.tags);
  const sourceUrl = raw.sourceUrl === undefined
    ? metadataText(frontmatter.sourceUrl ?? frontmatter.source_url ?? frontmatter.url) ?? (webUrl(frontmatter.source) ? metadataText(frontmatter.source) : null)
    : metadataText(raw.sourceUrl);
  const sourceRevision = raw.sourceRevision === undefined
    ? metadataText(frontmatter.sourceRevision ?? frontmatter.source_revision ?? frontmatter.revision) ?? source.revision
    : metadataText(raw.sourceRevision);
  const record = {
    path,
    markdown,
    title,
    category: metadataText(raw.category ?? frontmatter.category) ?? (path.includes('/') ? path.split('/')[0] : 'Uncategorized'),
    tags,
    language: language ? language.toLowerCase().replace(/_/g, '-') : inferLanguage(path, text),
    sourceId: source.id,
    sourceUrl,
    sourceRevision,
    fetchedAt: sourceDate(raw.fetchedAt === undefined ? frontmatter.fetchedAt ?? frontmatter.fetched_at ?? frontmatter.scraped_at : raw.fetchedAt),
    verifiedAt: sourceDate(raw.verifiedAt === undefined ? frontmatter.verifiedAt ?? frontmatter.verified_at : raw.verifiedAt),
    lastModified: sourceDate(raw.lastModified === undefined ? frontmatter.lastModified ?? frontmatter.last_modified : raw.lastModified),
  };
  const { markdown: _markdown, ...metadata } = record;
  let wordCount = 0;
  for (const token of words.segment(text)) if (token.isWordLike) wordCount++;
  const summary = {
    id: `doc_${createHash('sha256').update(`${source.id}\0${path}`).digest('hex').slice(0, 24)}`,
    ...metadata,
    hash: createHash('sha256').update(markdown).digest('hex'),
    wordCount,
    tokenEstimate: estimateTokens(body),
    sectionCount: sections.length,
    excerpt: excerptOf(text),
  };
  return { ...summary, record, body, sections, targets, links: [], backlinks: [] };
}

export function documentSummary(document, now) {
  const { record, body, sections, targets, links, backlinks, ...summary } = document;
  const verified = Math.max(...[summary.fetchedAt, summary.verifiedAt]
    .map(Date.parse).filter(time => Number.isFinite(time) && time <= now));
  return { ...summary, tags: [...summary.tags], status: verified === -Infinity ? 'unverified' : now - verified > freshnessWindow ? 'stale' : 'fresh' };
}

export function webUrl(value, base) {
  if (typeof value !== 'string' || !value.trim() || (base === undefined && !/^https?:\/\//i.test(value))) return null;
  try {
    const url = new URL(value, base);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function urlKey(url) {
  return url.origin + url.pathname + url.search;
}

function uniqueIndexEntry(map, key, document) {
  if (!map.has(key)) map.set(key, document);
  else if (map.get(key)?.id !== document.id) map.set(key, null);
}

function decodedPath(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function resolveTarget(target, from, urls, paths, aliases) {
  if (target.startsWith('#')) return null;
  const absolute = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target);
  const remote = webUrl(target, webUrl(from.sourceUrl) ?? undefined);
  const match = remote && urls.get(urlKey(remote));
  if (absolute || match) return match;

  const targetPath = decodedPath(target.split(/[?#]/, 1)[0]);
  if (!targetPath) return null;
  const base = targetPath.startsWith('/')
    ? posix.normalize(targetPath.slice(1))
    : posix.join(posix.dirname(from.path), targetPath);
  if (base === '..' || base.startsWith('../')) return null;
  const variants = [base, `${base}.md`, posix.join(base, 'README.md'), posix.join(base, 'index.md')];
  for (const variant of variants) {
    const match = paths.get(`${from.sourceId}\0${variant}`);
    if (match) return match;
  }
  if (!targetPath.includes('/')) return aliases.get(`${from.sourceId}\0${targetPath.normalize('NFKC').toLowerCase()}`);
  return null;
}

export function connectDocuments(documents) {
  const urls = new Map();
  const paths = new Map();
  const aliases = new Map();
  for (const document of documents) {
    const url = webUrl(document.sourceUrl);
    if (url) uniqueIndexEntry(urls, urlKey(url), document);
    paths.set(`${document.sourceId}\0${document.path}`, document);
    const filename = posix.basename(document.path);
    for (const alias of [filename, posix.basename(filename, posix.extname(filename)), document.title]) {
      uniqueIndexEntry(aliases, `${document.sourceId}\0${alias.normalize('NFKC').toLowerCase()}`, document);
    }
  }

  const links = new Map(documents.map(document => [document.id, []]));
  const backlinks = new Map(documents.map(document => [document.id, []]));
  const citation = ({ id, title, sourceUrl }) => ({ id, title, sourceUrl });
  for (const document of documents) {
    const seen = new Set([document.id]);
    for (const target of document.targets) {
      const match = resolveTarget(target, document, urls, paths, aliases);
      if (!match || seen.has(match.id)) continue;
      seen.add(match.id);
      links.get(document.id).push(citation(match));
      backlinks.get(match.id).push(citation(document));
    }
  }
  return documents.map(document => ({ ...document, links: links.get(document.id), backlinks: backlinks.get(document.id) }));
}
