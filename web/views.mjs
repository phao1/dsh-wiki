import { renderMarkdown, safeURL } from './markdown.mjs';

const numberFormat = new Intl.NumberFormat('zh-CN');
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const states = { fresh: '14 天内', stale: '超过 14 天', unverified: '时间未知' };
const sourceTypes = { github: 'GitHub', local: '本地 Markdown' };
const changeTypes = { added: '新增', changed: '修改', removed: '移除' };

export function el(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== '') element.textContent = text;
  return element;
}

export function icon(name) {
  const element = el('span', 'icon i-' + name);
  element.setAttribute('aria-hidden', 'true');
  return element;
}

export function action(label, name, { kind = 'secondary', glyph, data = {}, iconOnly = false } = {}) {
  const button = el('button', (iconOnly ? 'icon-button ' : 'button ') + kind);
  button.type = 'button';
  button.dataset.action = name;
  Object.assign(button.dataset, data);
  if (glyph) button.append(icon(glyph));
  if (iconOnly) {
    button.setAttribute('aria-label', label);
    button.title = label;
  } else {
    button.append(el('span', '', label));
  }
  return button;
}

export function link(label, href, className, glyph) {
  const element = el('a', className);
  element.href = href;
  if (glyph) element.append(icon(glyph));
  element.append(el('span', '', label));
  return element;
}

function externalLink(label, url, className = 'card-link') {
  const safe = safeURL(url);
  if (!safe) return null;
  const element = link(label, safe.href, className, 'external');
  element.target = '_blank';
  element.rel = 'noopener noreferrer';
  return element;
}

export function number(value) {
  return numberFormat.format(value);
}

export function time(value) {
  if (!value || Number.isNaN(Date.parse(value))) return el('span', '', '—');
  const element = el('time', '', dateFormat.format(new Date(value)));
  element.dateTime = value;
  element.title = value;
  return element;
}

export function sourceLabel(status, id) {
  return status?.sources?.find(source => source.id === id)?.name || id || '未知来源';
}

export function freshness(status, suffix = '') {
  const element = el('span', 'freshness ' + status);
  element.append(el('i', 'dot'), el('span', '', (states[status] || states.unverified) + suffix));
  return element;
}

function metadata(pairs) {
  const element = el('dl', 'metadata');
  for (const [label, value] of pairs) {
    const term = el('dt', '', label);
    const definition = el('dd');
    definition.append(value || '—');
    element.append(term, definition);
  }
  return element;
}

export function card(title, glyph, ...content) {
  const element = el('section', 'card');
  const header = el('div', 'card-header');
  const heading = el('h2');
  if (glyph) heading.append(icon(glyph));
  heading.append(el('span', '', title));
  header.append(heading);
  const body = el('div', 'card-body');
  body.append(...content.filter(Boolean));
  element.append(header, body);
  return element;
}

export function empty(title, message, control) {
  const element = el('div', 'card empty');
  element.append(el('h2', '', title), el('p', '', message));
  if (control) element.append(control);
  return element;
}

function pageHeading(title, description, ...controls) {
  const head = el('div', 'page-head');
  const text = el('div');
  text.append(el('h1', 'page-title', title), el('p', 'page-subtitle', description));
  const actions = el('div', 'page-actions');
  actions.append(...controls);
  head.append(text);
  if (controls.length) head.append(actions);
  return head;
}

export function optionsSelect(label, options, selected, name) {
  const select = el('select', 'filter');
  select.setAttribute('aria-label', label);
  select.name = name;
  for (const option of options) {
    const item = el('option', '', option.label);
    item.value = option.value;
    select.append(item);
  }
  select.value = selected;
  if (select.selectedIndex < 0) select.selectedIndex = 0;
  return select;
}

export function languageLabel(language) {
  return ({ zh: '中文', en: 'English', ja: '日本語', ko: '한국어' })[language] || language;
}

function libraryHero(status) {
  const element = el('section', 'library-head');
  const copy = el('div');
  copy.append(el('h1', 'page-title', '知识库'), el('p', 'page-subtitle', '检索技术文档，整理可复用的 Markdown 上下文。'));
  element.append(copy);
  if (status) {
    const list = el('dl', 'library-stats');
    for (const [label, value] of [['文档', status.documentCount], ['段落', status.sectionCount], ['来源', status.sources.length]]) {
      const cell = el('div');
      cell.append(el('dt', '', label), el('dd', '', number(value)));
      list.append(cell);
    }
    element.append(list);
  }
  return element;
}

function highlighted(element, text, terms = []) {
  const needles = terms.filter(term => term && term.length < 100).slice(0, 15);
  if (!needles.length) {
    element.textContent = text;
    return;
  }
  const lowerText = text.toLowerCase();
  const lowercaseTerms = needles.map(term => term.toLowerCase());
  let cursor = 0;
  while (cursor < text.length) {
    let start = -1;
    let length = 0;
    for (const term of lowercaseTerms) {
      const index = lowerText.indexOf(term, cursor);
      if (index >= 0 && (start < 0 || index < start || (index === start && term.length > length))) {
        start = index;
        length = term.length;
      }
    }
    if (start < 0) break;
    element.append(text.slice(cursor, start), el('mark', '', text.slice(start, start + length)));
    cursor = start + length;
  }
  element.append(text.slice(cursor));
}

function documentRow(doc, ui) {
  const row = el('li', 'doc-row');
  const glyph = el('div', 'doc-glyph');
  glyph.append(icon('doc'));
  const body = el('div');
  const title = el('h3');
  const titleLink = link(doc.title, ui.documentHref(doc.id, doc.sectionAnchor));
  highlighted(titleLink, doc.title, doc.matchedTerms);
  title.append(titleLink);
  const excerpt = el('p', 'doc-excerpt');
  highlighted(excerpt, doc.snippet || doc.excerpt || doc.path, doc.matchedTerms);
  const meta = el('div', 'doc-meta');
  meta.append(freshness(doc.status), el('span', '', doc.category), el('span', '', languageLabel(doc.language)));
  if (doc.sectionTitle && doc.sectionTitle !== doc.title) meta.append(el('span', '', doc.sectionTitle));
  else meta.append(el('span', '', doc.path));
  body.append(title, excerpt, meta);
  const select = action('加入上下文篮：' + doc.title, 'toggle-select', {
    kind: 'outline', glyph: 'plus', iconOnly: true, data: { id: doc.id, title: doc.title, label: 'icon' },
  });
  row.append(glyph, body, select);
  return row;
}

export function libraryView(ui, data) {
  const fragment = document.createDocumentFragment();
  fragment.append(libraryHero(ui.status));
  const header = el('div', 'section-header');
  const title = el('h2', '', ui.route.q ? '搜索结果' : ui.route.category || '全部文档');
  if (data && !data.error) title.append(el('span', '', number(data.total) + ' 篇'));
  const controls = el('div', 'controls');
  if (ui.status) {
    const categories = ui.status.categories.map(({ name }) => ({ value: name, label: name }));
    const languages = ui.status.languages.map(({ name }) => ({ value: name, label: languageLabel(name) }));
    const sources = ui.status.sources.map(({ id, name }) => ({ value: id, label: name }));
    controls.append(
      optionsSelect('按分类筛选', [{ label: '全部分类', value: '' }, ...categories], ui.route.category, 'category'),
      optionsSelect('按语言筛选', [{ label: '全部语言', value: '' }, ...languages], ui.route.language, 'language'),
    );
    if (sources.length > 1 || ui.route.sourceId) {
      controls.append(optionsSelect('按来源筛选', [{ label: '全部来源', value: '' }, ...sources], ui.route.sourceId, 'sourceId'));
    }
  }
  header.append(title, controls);
  fragment.append(header);
  if (ui.route.tag || ui.route.q) {
    const filters = el('div', 'active-filter');
    if (ui.route.q) filters.append(link('关键词 · ' + ui.route.q + ' ×', ui.href({ ...ui.route, q: '' }), 'chip'));
    if (ui.route.tag) filters.append(link('标签 · ' + ui.route.tag + ' ×', ui.href({ ...ui.route, tag: '' }), 'chip'));
    fragment.append(filters);
  }
  if (!data) fragment.append(el('div', 'card loading', '正在读取文档…'));
  else if (data.error) fragment.append(empty('无法读取文档', data.error, action('重试', 'retry')));
  else {
    const documents = data.results || data.documents;
    if (!documents.length) {
      fragment.append(empty('没有匹配的文档', '试试其他关键词或调整筛选条件。', link('查看全部文档', '#library', 'button secondary')));
    } else {
      const list = el('ul', 'card doc-list');
      list.append(...documents.map(doc => documentRow(doc, ui)));
      fragment.append(list);
      if (data.total > documents.length) {
        const more = el('div', 'more-bar');
        more.append(action('加载更多 · ' + number(data.total - documents.length) + ' 篇', 'more', { glyph: 'arrow' }));
        fragment.append(more);
      }
    }
  }
  return fragment;
}

export function basketPanel(ui, inDialog = false) {
  const container = el('div');
  if (!ui.selected.size) {
    const prompt = el('div', 'basket-empty');
    prompt.append(icon('doc'), el('p', '', '通过文档旁的加号收集条目。'));
    container.append(prompt);
  } else {
    const list = el('ul', 'basket-list');
    for (const [id, title] of ui.selected) {
      const item = el('li');
      item.append(link(title, ui.documentHref(id)), action('移除：' + title, 'toggle-select', {
        kind: '', glyph: 'close', iconOnly: true, data: { id, title, label: 'remove' },
      }));
      list.append(item);
    }
    container.append(list);
  }
  const controls = el('div', 'basket-controls');
  const build = action('生成上下文包', 'context', { kind: 'primary', glyph: 'arrow' });
  build.disabled = !ui.selected.size;
  const budgets = [2000, 4000, 8000, 16000].map(value => ({ value, label: number(value) }));
  const budget = optionsSelect('估算 token 预算', budgets, String(ui.budget), 'budget');
  budget.title = '估算 token 预算';
  controls.append(build, budget);
  container.append(el('p', 'basket-hint', '预算按估算 token 计算。'), controls);
  if (ui.route.q && ui.route.view === 'library') {
    container.append(action('按关键词生成', 'context-query', { kind: 'ghost basket-query' }));
  }
  if (inDialog) return container;
  const panel = card('上下文篮', 'basket', container);
  panel.firstChild.append(el('span', 'count-pill', number(ui.selected.size)));
  return panel;
}

export function overviewPanel(status) {
  if (!status) return null;
  const list = el('div', 'source-compact');
  for (const source of status.sources) {
    const line = el('div', 'source-line');
    line.append(el('span', '', source.name), el('span', '', number(source.documentCount) + ' 篇'));
    list.append(line);
  }
  if (!list.childElementCount) list.append(el('p', 'note', '尚无来源。'));
  return card('知识来源', 'sources', list, link('管理来源', '#sources', 'card-link', 'arrow'));
}

function documentSource(doc, ui) {
  const hash = el('code', '', doc.hash?.slice(0, 12));
  if (doc.hash) hash.title = doc.hash;
  return card('文档来源', 'sources', metadata([
    ['来源', sourceLabel(ui.status, doc.sourceId)],
    ['路径', doc.path],
    ['状态', freshness(doc.status)],
    ['抓取时间', time(doc.fetchedAt)],
    ['验证时间', time(doc.verifiedAt)],
    ...(doc.lastModified ? [['上游修改时间', time(doc.lastModified)]] : []),
    ['版本', el('code', '', doc.sourceRevision || '—')],
    ['内容哈希', hash],
  ]), externalLink(doc.sourceRevision ? '打开固定版本' : '查看原始来源', doc.sourceUrl));
}

export function documentToc(doc, ui) {
  if (!doc.sections?.length) return null;
  const list = el('ol', 'toc-list');
  for (const section of doc.sections) {
    const item = el('li');
    const anchor = link(section.title, ui.documentHref(doc.id, section.anchor));
    anchor.dataset.section = section.anchor;
    if (ui.route.section === section.anchor) anchor.setAttribute('aria-current', 'location');
    item.append(anchor);
    list.append(item);
  }
  return card('文档目录', 'library', list);
}

function relatedLinks(title, documents, ui) {
  if (!documents?.length) return null;
  const list = el('ul', 'link-list');
  for (const doc of documents) {
    const item = el('li');
    item.append(link(doc.title, ui.documentHref(doc.id)));
    list.append(item);
  }
  return card(title, null, list);
}

function localLinkIndex(doc) {
  const index = new Map();
  for (const target of [...(doc.links || []), ...(doc.backlinks || [])]) {
    const url = safeURL(target.sourceUrl);
    if (!url) continue;
    url.hash = '';
    index.set(url.href, target.id);
  }
  return index;
}

export function documentView(ui, doc) {
  const fragment = document.createDocumentFragment();
  fragment.append(link('返回知识库', ui.href(ui.lastLibrary), 'breadcrumb', 'back'));
  if (!doc) {
    fragment.append(el('div', 'card loading', '正在读取文档…'));
    return { main: fragment, tools: [] };
  }
  if (doc.error) {
    fragment.append(empty('无法打开文档', doc.error, action('重试', 'retry')));
    return { main: fragment, tools: [] };
  }

  const article = el('article', 'card doc-card');
  const head = el('header', 'document-head');
  const meta = el('div', 'doc-meta');
  meta.append(freshness(doc.status), el('span', '', doc.category), el('span', '', languageLabel(doc.language)), el('span', '', doc.path));
  head.append(meta, el('h1', 'page-title', doc.title));
  const controls = el('div', 'page-actions');
  controls.append(action('加入上下文篮', 'toggle-select', {
    kind: 'primary', glyph: 'plus', data: { id: doc.id, title: doc.title, label: 'full' },
  }));
  const original = externalLink('打开来源', doc.sourceUrl, 'button secondary');
  if (original) controls.append(original);
  controls.append(action('复制文档链接', 'copy-link', { kind: 'ghost' }));
  if (doc.sections?.length) controls.append(action('文档目录', 'toc', { kind: 'secondary mobile-toc', glyph: 'library' }));
  head.append(controls);
  if (doc.tags?.length) {
    const tags = el('div', 'tag-list');
    for (const tag of doc.tags) tags.append(link(tag, ui.href({ view: 'library', tag }), 'chip'));
    head.append(tags);
  }
  const body = el('div', 'markdown');
  const localLinks = localLinkIndex(doc);
  body.append(renderMarkdown(doc.body, {
    baseURL: safeURL(doc.sourceUrl)?.href,
    sections: doc.sections || [],
    hideTitle: doc.title,
    sectionHref: section => ui.documentHref(doc.id, section),
    documentHref: url => {
      const section = url.hash ? decodeFragment(url.hash.slice(1)) : '';
      url.hash = '';
      const id = localLinks.get(url.href);
      return id ? ui.documentHref(id, section) : null;
    },
  }));
  const renderedAnchors = new Set(Array.from(body.querySelectorAll('[id]'), element => element.id));
  for (const section of doc.sections || []) {
    const id = 'dsh-section-' + section.anchor;
    if (!renderedAnchors.has(id)) {
      const missingAnchor = el('span', 'document-title-anchor');
      missingAnchor.id = id;
      missingAnchor.setAttribute('aria-hidden', 'true');
      body.prepend(missingAnchor);
    }
  }
  article.append(head, body);
  fragment.append(article);
  return { main: fragment, tools: [
    documentToc(doc, ui), documentSource(doc, ui), relatedLinks('反向链接', doc.backlinks, ui), relatedLinks('关联文档', doc.links, ui),
  ].filter(Boolean) };
}

function decodeFragment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function historyView(ui, data) {
  const fragment = document.createDocumentFragment();
  fragment.append(pageHeading('更新历史', '按来源查看同步和导入记录，比较文档的最近一次变更。'));
  if (!data) fragment.append(el('div', 'card loading', '正在读取更新记录…'));
  else if (data.error) fragment.append(empty('无法读取更新记录', data.error, action('重试', 'retry')));
  else if (!data.length) {
    fragment.append(empty('暂无更新记录', '首次同步或导入后，变更会显示在这里。', link('查看来源', '#sources', 'button secondary')));
  } else {
    const list = el('ol', 'history-list');
    for (const batch of data) {
      const entry = el('li', 'card history-entry');
      const heading = el('div', 'history-heading');
      heading.append(el('h2', '', sourceLabel(ui.status, batch.sourceId)), time(batch.at));
      const counts = el('div', 'change-counts');
      counts.append(el('span', 'chip', '新增 ' + number(batch.added)), el('span', 'chip', '修改 ' + number(batch.changed)), el('span', 'chip', '移除 ' + number(batch.removed)));
      entry.append(heading, counts);
      if (batch.changes?.length) {
        const changes = el('ul', 'change-list');
        for (const change of batch.changes) {
          const item = el('li');
          const name = el('div', 'change-name');
          const title = change.type === 'removed' ? el('span', '', change.title) : link(change.title, ui.documentHref(change.documentId));
          name.append(el('span', 'chip', changeTypes[change.type] || change.type), title);
          item.append(name, action('查看最近差异', 'diff', { kind: 'secondary small', data: { id: change.documentId } }));
          changes.append(item);
        }
        entry.append(changes);
      }
      list.append(entry);
    }
    fragment.append(list);
  }
  return fragment;
}

export function sourcesView(ui, statusError) {
  const fragment = document.createDocumentFragment();
  const sync = action(ui.syncing || ui.status?.syncRunning ? '正在同步…' : '同步官方来源', 'sync', { kind: 'primary', glyph: 'refresh' });
  sync.disabled = ui.syncing || Boolean(ui.status?.syncRunning);
  fragment.append(pageHeading('来源管理', '管理 Markdown 来源、核对版本并导出索引。', action('导入 Markdown', 'import', { glyph: 'plus' }), sync));
  if (statusError) fragment.append(empty('无法读取来源', statusError, action('重试', 'retry')));
  else if (!ui.status) fragment.append(el('div', 'card loading', '正在读取来源…'));
  else if (!ui.status.sources.length) fragment.append(empty('暂无来源', '导入 Markdown 或同步官方来源以添加文档。'));
  else {
    const list = el('ul', 'source-list');
    for (const source of ui.status.sources) {
      const item = el('li', 'card source-entry');
      const heading = el('div', 'source-heading');
      heading.append(el('h2', '', source.name), el('span', 'chip', sourceTypes[source.type] || source.type));
      item.append(heading, metadata([
        ['文档数', number(source.documentCount)],
        ['版本', el('code', '', source.revision || '—')],
        ['最近检查', time(source.checkedAt)],
      ]));
      const controls = el('div', 'page-actions source-actions');
      controls.append(link('浏览文档', ui.href({ view: 'library', sourceId: source.id }), 'button secondary', 'doc'));
      const original = externalLink('打开来源', source.url, 'button secondary');
      if (original) controls.append(original);
      item.append(controls);
      list.append(item);
    }
    fragment.append(list);
  }
  const syncStatus = ui.syncReport || ui.status?.lastSync;
  if (syncStatus) {
    const message = syncStatus.ok
      ? '同步完成 · 新增 ' + number(syncStatus.added ?? 0) + ' · 修改 ' + number(syncStatus.changed ?? 0) + ' · 移除 ' + number(syncStatus.removed ?? 0)
      : '同步失败 · ' + (syncStatus.error || '请求失败');
    const report = el('div', 'notice', message);
    if (syncStatus.ok) report.classList.add('success-note');
    report.setAttribute('role', 'status');
    fragment.append(report);
  }
  return fragment;
}

export function freshnessPanel(status) {
  if (!status?.freshness) return null;
  const summary = el('div', 'status-overview');
  for (const state of Object.keys(states)) summary.append(freshness(state, ' ' + number(status.freshness[state] || 0)));
  return card('时效状态', 'history', summary, el('p', 'note', '依据记录的抓取／验证时间计算，不代表内容正确性。'));
}

export function exportPanel() {
  const list = el('div', 'export-links');
  for (const [format, name] of [
    ['manifest', 'Manifest JSON'], ['llms', 'llms.txt'], ['index', '文档索引 Markdown'], ['crossrefs', '文档交叉引用'],
  ]) {
    const download = action(name, 'export', { glyph: 'download', data: { format } });
    list.append(download);
  }
  return card('导出知识库', 'download', list);
}
