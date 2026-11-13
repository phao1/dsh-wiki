import {
  action, basketPanel, documentToc, documentView, el, exportPanel, freshnessPanel, historyView, icon,
  libraryView, link, number, overviewPanel, sourcesView, time,
} from './views.mjs';

const get = id => document.getElementById(id);
const workspace = get('workspace');
const utility = get('utility');
const globalSearch = get('global-search');
const dialog = get('dialog');
const dialogContent = get('dialog-content');
const shell = document.querySelector('.shell');
const routeFields = ['q', 'category', 'language', 'sourceId', 'tag', 'id', 'section'];
const libraryFilters = routeFields.slice(0, 5);
const pageSize = 12;

function stored(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The workspace continues to work when storage is blocked.
  }
}

const savedSelection = stored('dsh-basket', []);
const selected = new Map(Array.isArray(savedSelection)
  ? savedSelection.filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string')
  : []);
const savedBudget = stored('dsh-budget', 4000);
let budget = [2000, 4000, 8000, 16000].includes(savedBudget) ? savedBudget : 4000;
let status = null;
let statusError = '';
let syncing = false;
let syncReport = null;
let data = null;
let limit = pageSize;
let requestSequence = 0;
let statusSequence = 0;
let dialogSequence = 0;
let dialogMode = '';
let dialogOpener = null;
let searchTimer;
let searchSession = false;
let toastTimer;
let renderTools = [];

function readRoute() {
  const [view, query] = location.hash.slice(1).split('?', 2);
  const params = new URLSearchParams(query);
  const route = { view: ['library', 'document', 'history', 'sources'].includes(view) ? view : 'library' };
  for (const key of routeFields) route[key] = params.get(key) || '';
  return route;
}

function href(route) {
  const params = new URLSearchParams();
  for (const key of routeFields) if (route[key]) params.set(key, route[key]);
  const query = params.toString();
  return '#' + route.view + (query ? '?' + query : '');
}

function currentLibrary(route) {
  return { view: 'library', ...Object.fromEntries(libraryFilters.map(key => [key, route[key] || ''])) };
}

let route = readRoute();
let lastLibrary = currentLibrary(route);

function documentHref(id, section = '') {
  return href({ ...lastLibrary, view: 'document', id, section });
}

function ui() {
  return { route, lastLibrary, status, selected, budget, syncing, syncReport, href, documentHref };
}

function renderNav() {
  for (const item of document.querySelectorAll('[data-view-link]')) {
    const active = item.dataset.viewLink === (route.view === 'document' ? 'library' : route.view);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  const categories = get('categories');
  categories.replaceChildren();
  if (status?.categories.length) {
    categories.append(el('p', 'nav-label', '文档分类'));
    for (const category of status.categories) {
      const url = href({ ...lastLibrary, view: 'library', category: category.name });
      const item = link(category.name, url);
      item.prepend(el('span', 'category-mark'));
      item.append(el('span', 'category-count', number(category.count)));
      if (route.view === 'library' && category.name === route.category) item.setAttribute('aria-current', 'page');
      categories.append(item);
    }
  }
  const foot = get('sidebar-foot');
  foot.replaceChildren();
  const state = el('p');
  if (statusError) {
    state.append(el('span', 'dot error-text'), el('span', '', '知识库连接失败'));
    foot.append(state);
  } else if (status) {
    state.append(el('span', 'dot good'), el('span', '', '本地知识库'));
    foot.append(state);
    if (status.lastUpdated) {
      const updated = time(status.lastUpdated);
      updated.title = '最近更新 · ' + status.lastUpdated;
      foot.append(updated);
    }
  }
}

function renderSelections() {
  const basket = utility.querySelector('[data-basket-panel]');
  const panel = basketPanel(ui());
  panel.dataset.basketPanel = '';
  if (basket) basket.replaceWith(panel);
  else utility.prepend(panel);
  if (dialogMode === 'basket' && dialog.open) {
    get('dialog-title').textContent = '上下文篮 · ' + number(selected.size) + ' 篇';
    dialogContent.replaceChildren(basketPanel(ui(), true));
  }
  const counter = get('mobile-basket-count');
  counter.hidden = !selected.size;
  counter.textContent = String(selected.size);
  get('basket-toggle').setAttribute('aria-label', '打开上下文篮' + (selected.size ? '，已选 ' + selected.size + ' 篇' : ''));

  for (const button of workspace.querySelectorAll('[data-action="toggle-select"]')) {
    const isSelected = selected.has(button.dataset.id);
    button.setAttribute('aria-pressed', String(isSelected));
    button.classList.toggle('is-selected', isSelected);
    const symbol = button.dataset.label === 'icon';
    const verb = isSelected ? '移出上下文篮' : '加入上下文篮';
    button.replaceChildren(icon(isSelected ? 'check' : 'plus'));
    if (symbol) {
      button.setAttribute('aria-label', verb + '：' + button.dataset.title);
      button.title = verb + '：' + button.dataset.title;
    } else {
      button.append(el('span', '', isSelected ? '已加入上下文篮' : verb));
      button.setAttribute('aria-label', verb + '：' + button.dataset.title);
    }
  }
}

function draw() {
  renderNav();
  const view = route.view;
  const context = ui();
  let main;
  if (view === 'document') {
    const result = documentView(context, data);
    main = result.main;
    renderTools = result.tools;
  } else if (view === 'history') {
    main = historyView(context, data);
    renderTools = [overviewPanel(status), exportPanel()];
  } else if (view === 'sources') {
    main = sourcesView(context, statusError);
    renderTools = [exportPanel(), freshnessPanel(status)];
  } else {
    main = libraryView(context, data);
    renderTools = [overviewPanel(status), freshnessPanel(status)];
  }
  workspace.replaceChildren(main);
  workspace.setAttribute('aria-busy', String(view === 'sources' ? !status && !statusError : !data));
  utility.replaceChildren(...renderTools.filter(Boolean));
  renderSelections();
  document.title = (view === 'document' && data?.title ? data.title + ' · ' : '') + 'DSH Wiki · 知识工作台';
}

async function checkedFetch(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error('无法连接本地服务。请确认 DSH Wiki 正在运行。');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const error = new Error(body?.error || '请求失败 · HTTP ' + response.status);
    error.status = response.status;
    error.code = body?.code;
    throw error;
  }
  return response;
}

async function api(path, body) {
  const options = body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  return (await checkedFetch('/api/' + path, options)).json();
}

async function loadStatus() {
  const sequence = ++statusSequence;
  try {
    const value = await api('status');
    if (sequence !== statusSequence) return;
    status = value;
    statusError = '';
  } catch (error) {
    if (sequence !== statusSequence) return;
    statusError = error.message;
  }
  draw();
}

function scrollToSection() {
  if (route.view !== 'document' || !route.section) return;
  const target = document.getElementById('dsh-section-' + route.section);
  if (!target || !workspace.contains(target)) return;
  target.scrollIntoView({ block: 'start' });
  for (const anchor of utility.querySelectorAll('[data-section]')) {
    if (anchor.dataset.section === route.section) anchor.setAttribute('aria-current', 'location');
    else anchor.removeAttribute('aria-current');
  }
}

async function loadPage(keepData = false) {
  const sequence = ++requestSequence;
  const requestRoute = route;
  if (!keepData) data = null;
  draw();
  if (requestRoute.view === 'sources') return;

  let path;
  if (requestRoute.view === 'document') {
    path = 'document?' + new URLSearchParams({ id: requestRoute.id });
  } else if (requestRoute.view === 'history') {
    path = 'history';
  } else {
    const params = new URLSearchParams({ limit: String(limit) });
    for (const key of libraryFilters) if (requestRoute[key]) params.set(key, requestRoute[key]);
    path = (requestRoute.q ? 'search?' : 'documents?') + params;
  }

  try {
    const value = await api(path);
    if (sequence !== requestSequence) return;
    data = value;
  } catch (error) {
    if (sequence !== requestSequence) return;
    data = { error: error.status === 404 && requestRoute.view === 'document' ? '此文档已移除或链接无效。' : error.message };
  }
  draw();
  if (route.view === 'document' && route.section) requestAnimationFrame(scrollToSection);
}

function closeNav(focus = false) {
  shell.classList.remove('nav-open');
  const button = get('nav-toggle');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', '打开导航');
  if (focus) button.focus();
}

function applyRoute(focus = false) {
  clearTimeout(searchTimer);
  closeNav();
  const next = readRoute();
  const previous = route;
  route = next;
  globalSearch.value = route.q;
  if (route.view === 'library' || route.view === 'document') lastLibrary = currentLibrary(route);
  const onlySection = route.view === 'document' && previous.view === 'document'
    && route.id === previous.id && libraryFilters.every(key => route[key] === previous[key]);
  if (onlySection && data && !data.error) {
    requestAnimationFrame(scrollToSection);
    return;
  }
  limit = pageSize;
  window.scrollTo(0, 0);
  if (focus) workspace.focus({ preventScroll: true });
  void loadPage();
}

function navigate(next, { replace = false, focus = false } = {}) {
  const target = href(next);
  if (target === location.hash) return;
  if (replace) history.replaceState(null, '', target);
  else history.pushState(null, '', target);
  applyRoute(focus);
}

function search() {
  const q = globalSearch.value.trim();
  if (q === route.q && route.view === 'library') return;
  const base = route.view === 'library' ? lastLibrary : { view: 'library' };
  navigate({ ...base, q }, { replace: searchSession });
  searchSession = true;
}

function toast(text) {
  const box = get('toast');
  clearTimeout(toastTimer);
  box.hidden = false;
  box.textContent = text;
  toastTimer = setTimeout(() => { box.hidden = true; }, 4200);
}

function showDialog(title, content, mode, wide = false) {
  const sequence = ++dialogSequence;
  dialogMode = mode;
  get('dialog-title').textContent = title;
  dialog.classList.toggle('wide', wide);
  dialogContent.replaceChildren(content);
  if (!dialog.open) {
    dialogOpener = document.activeElement;
    dialog.showModal();
  }
  return sequence;
}

function dialogActive(sequence) {
  return dialog.open && sequence === dialogSequence;
}

function dialogActions(...controls) {
  const element = el('div', 'dialog-actions');
  element.append(...controls);
  return element;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const element = el('a');
  element.href = url;
  element.download = filename;
  document.body.append(element);
  element.click();
  element.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function copy(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制');
      return;
    } catch {
      // Browsers without permission may still allow the selection fallback.
    }
  }
  const field = el('textarea', 'sr-only');
  field.value = text;
  const active = document.activeElement;
  (dialog.open ? dialogContent : document.body).append(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    field.remove();
    active?.focus({ preventScroll: true });
  }
  toast(copied ? '已复制' : '复制失败，请手动选择文本。');
}

async function buildContext(byQuery) {
  const ids = byQuery ? [] : Array.from(selected.keys());
  const query = byQuery ? route.q : '';
  if (!ids.length && !query) return;
  const sequence = showDialog('上下文包', el('p', 'note', '正在生成 Markdown…'), 'context', true);
  try {
    const pack = await api('context', { query, ids, budget });
    if (!dialogActive(sequence)) return;
    const fragment = document.createDocumentFragment();
    fragment.append(el('p', 'note', number(pack.documents.length) + ' 篇文档 · 约 ' + number(pack.tokenEstimate) +
      ' / ' + number(pack.budget) + ' token' + (pack.truncated ? ' · 内容已按预算截断' : '')));
    if (pack.warnings?.length) {
      const notices = el('ul', 'notice');
      for (const warning of pack.warnings) notices.append(el('li', '', warning));
      fragment.append(notices);
    }
    const preview = el('pre', 'preview', pack.markdown || '没有可打包的内容。');
    preview.tabIndex = 0;
    preview.setAttribute('aria-label', 'Markdown 上下文预览');
    fragment.append(preview);
    const copyButton = action('复制 Markdown', 'copy-context');
    const downloadButton = action('下载 .md', 'download-context', { kind: 'primary', glyph: 'download' });
    copyButton.disabled = downloadButton.disabled = !pack.markdown;
    copyButton.addEventListener('click', () => { void copy(pack.markdown); });
    downloadButton.addEventListener('click', () => download(new Blob([pack.markdown], { type: 'text/markdown;charset=utf-8' }), 'dsh-context.md'));
    fragment.append(dialogActions(copyButton, downloadButton));
    dialogContent.replaceChildren(fragment);
  } catch (error) {
    if (dialogActive(sequence)) dialogContent.replaceChildren(el('p', 'error-text', error.message));
  }
}

function field(label, input) {
  const element = el('label', 'form-label');
  element.append(el('span', '', label), input);
  return element;
}

function importDialog() {
  const form = el('form');
  form.append(el('p', 'note', '选择一个或多个 Markdown 文件。相同来源下的同名文件会更新为新版本。'));
  const files = el('input', 'form-input');
  files.type = 'file';
  files.accept = '.md,.markdown,text/markdown,text/x-markdown';
  files.multiple = true;
  files.required = true;
  const name = el('input', 'form-input');
  name.value = '本地 Markdown';
  name.maxLength = 80;
  name.required = true;
  const message = el('p', 'form-message');
  message.setAttribute('role', 'status');
  const submit = action('导入文档', 'submit-import', { kind: 'primary', glyph: 'plus' });
  submit.type = 'submit';
  form.append(field('Markdown 文件', files), field('来源名称', name), message,
    dialogActions(action('取消', 'close-dialog'), submit));
  const sequence = showDialog('导入 Markdown', form, 'import');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled) return;
    const chosen = Array.from(files.files);
    const title = name.value.trim();
    if (!title || !chosen.length) return;
    if (chosen.some(file => !/\.(md|markdown)$/i.test(file.name))) {
      message.textContent = '请选择 .md 或 .markdown 文件。';
      message.classList.add('error-text');
      return;
    }
    submit.disabled = true;
    message.classList.remove('error-text');
    message.textContent = '正在导入…';
    try {
      const documents = await Promise.all(chosen.map(async file => ({ path: file.name, markdown: await file.text() })));
      const previous = status?.sources.find(source => source.type === 'local' && source.name === title);
      const sourceBytes = new TextEncoder().encode(title);
      const digest = await crypto.subtle.digest('SHA-256', sourceBytes);
      const sourceHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      const id = previous?.id || (title === '本地 Markdown' ? 'local-import' : 'local-' + sourceHash.slice(0, 24));
      const result = await api('import', { documents, source: { id, name: title, type: 'local' }, replace: false });
      void loadStatus();
      toast('导入完成 · 新增 ' + number(result.added) + ' · 修改 ' + number(result.changed) + ' · 相同 ' + number(result.unchanged));
      if (dialogActive(sequence)) {
        dialog.close();
        const target = { view: 'library', sourceId: id };
        if (location.hash === href(target)) void loadPage(true);
        else navigate(target, { focus: true });
      } else {
        void loadPage(true);
      }
    } catch (error) {
      if (dialogActive(sequence)) {
        message.classList.add('error-text');
        message.textContent = error.message;
      }
    } finally {
      submit.disabled = false;
    }
  });
}

async function showDiff(id) {
  const sequence = showDialog('文档差异', el('p', 'note', '正在读取差异…'), 'diff', true);
  try {
    const diff = await api('diff?' + new URLSearchParams({ id }));
    if (!dialogActive(sequence)) return;
    get('dialog-title').textContent = '文档差异 · ' + diff.title;
    const list = el('div', 'diff');
    list.tabIndex = 0;
    list.setAttribute('aria-label', '逐行文档差异');
    let added = 0;
    let removed = 0;
    for (const change of diff.changes) {
      const isAdded = change.type === 'added';
      const isRemoved = change.type === 'removed';
      added += Number(isAdded);
      removed += Number(isRemoved);
      const line = el('div', 'diff-line ' + change.type);
      line.append(el('span', 'diff-sign', isAdded ? '+' : isRemoved ? '−' : ' '), el('span', '', change.text || '\u00a0'));
      list.append(line);
    }
    dialogContent.replaceChildren(el('p', 'note', '最近一次保留的变更 · 新增 ' + number(added) + ' 行 · 移除 ' + number(removed) + ' 行'), list);
  } catch (error) {
    if (dialogActive(sequence)) {
      dialogContent.replaceChildren(el('p', 'note', error.status === 404 ? '此文档暂无可比较的历史版本。' : error.message));
    }
  }
}

async function sync() {
  if (syncing || status?.syncRunning) return;
  syncing = true;
  syncReport = null;
  draw();
  try {
    const result = await api('sync', {});
    syncReport = { ...result, ok: true };
    toast('官方来源同步完成');
  } catch (error) {
    syncReport = { ok: false, error: error.message };
    toast('同步失败 · ' + error.message);
  } finally {
    syncing = false;
    void loadStatus();
    void loadPage(true);
  }
}

async function exportFile(format) {
  try {
    const response = await checkedFetch('/api/export?' + new URLSearchParams({ format }));
    const filename = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] || 'dsh-wiki-' + format;
    download(await response.blob(), filename);
  } catch (error) {
    toast('导出失败 · ' + error.message);
  }
}

function toggleSelection(button) {
  const { id, title } = button.dataset;
  if (selected.has(id)) selected.delete(id);
  else selected.set(id, title);
  save('dsh-basket', [...selected]);
  renderSelections();
  if (button.dataset.label === 'remove') {
    const region = dialogMode === 'basket' && dialog.open ? dialogContent : utility;
    region.querySelector('[data-action="toggle-select"], [name="budget"]')?.focus();
  }
}

document.addEventListener('click', event => {
  const anchor = event.target.closest('a[href^="#"]');
  if (anchor && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    if (anchor.classList.contains('skip-link')) {
      event.preventDefault();
      workspace.focus();
      return;
    }
    if (dialog.open && dialog.contains(anchor)) dialog.close();
    if (anchor.hash === location.hash) {
      event.preventDefault();
      closeNav();
      scrollToSection();
    }
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) {
    if (event.target === dialog) dialog.close();
    if (shell.classList.contains('nav-open') && !event.target.closest('.sidebar, #nav-toggle')) closeNav();
    return;
  }
  switch (button.dataset.action) {
    case 'retry':
      void loadStatus();
      void loadPage();
      break;
    case 'more':
      limit += pageSize;
      void loadPage(true);
      break;
    case 'toggle-select':
      toggleSelection(button);
      break;
    case 'basket':
      showDialog('上下文篮 · ' + number(selected.size) + ' 篇', basketPanel(ui(), true), 'basket');
      break;
    case 'toc':
      showDialog('文档目录', documentToc(data, ui()), 'toc');
      break;
    case 'context':
      void buildContext(false);
      break;
    case 'context-query':
      void buildContext(true);
      break;
    case 'import':
      importDialog();
      break;
    case 'close-dialog':
      dialog.close();
      break;
    case 'sync':
      void sync();
      break;
    case 'export':
      void exportFile(button.dataset.format);
      break;
    case 'diff':
      void showDiff(button.dataset.id);
      break;
    case 'copy-link':
      void copy(location.href);
      break;
    case 'copy-code':
      void copy(button.closest('.code-block').querySelector('pre').textContent);
      break;
    default:
      break;
  }
});

document.addEventListener('change', event => {
  const { name, value } = event.target;
  if (name === 'budget') {
    budget = Number(value);
    save('dsh-budget', budget);
    const others = document.querySelectorAll('select[name="budget"]');
    for (const control of others) control.value = value;
  } else if (route.view === 'library' && libraryFilters.includes(name) && event.target instanceof HTMLSelectElement) {
    navigate({ ...lastLibrary, [name]: value });
  }
});

get('search-form').addEventListener('submit', event => {
  event.preventDefault();
  clearTimeout(searchTimer);
  search();
});

function scheduleSearch(event) {
  if (event.isComposing) return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(search, 180);
}
globalSearch.addEventListener('focus', () => { searchSession = false; });
globalSearch.addEventListener('input', scheduleSearch);
globalSearch.addEventListener('compositionend', scheduleSearch);
get('search-shortcut').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K';

window.addEventListener('hashchange', () => {
  if (location.hash === '#workspace') {
    workspace.focus({ preventScroll: true });
    return;
  }
  applyRoute(true);
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && shell.classList.contains('nav-open')) closeNav(true);
  if (dialog.open || event.isComposing) return;
  const typing = event.target.closest('input, textarea, select, [contenteditable]');
  if (((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') || (!typing && event.key === '/')) {
    event.preventDefault();
    closeNav();
    globalSearch.focus();
    globalSearch.select();
  }
});

get('nav-toggle').addEventListener('click', event => {
  const active = shell.classList.toggle('nav-open');
  event.currentTarget.setAttribute('aria-expanded', String(active));
  event.currentTarget.setAttribute('aria-label', active ? '关闭导航' : '打开导航');
  if (active) document.querySelector('.navigation a[aria-current], .navigation a')?.focus();
});

dialog.addEventListener('close', () => {
  ++dialogSequence;
  dialogMode = '';
  if (dialogOpener?.isConnected && document.activeElement === document.body) dialogOpener.focus({ preventScroll: true });
  dialogOpener = null;
});

globalSearch.value = route.q;
void loadStatus();
void loadPage();
