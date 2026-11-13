function appendText(target, text) {
  target.append(document.createTextNode(text));
}

function node(tag, text) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

export function safeURL(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = base ? new URL(value, base) : new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function appendLink(parent, label, href, options, depth, image) {
  if (!image && href.startsWith('#') && href.length > 1) {
    const anchor = node('a');
    let id;
    try {
      id = decodeURIComponent(href.slice(1));
    } catch {
      id = href.slice(1);
    }
    anchor.href = options.sectionHref?.(id) || href;
    anchor.dataset.section = id;
    inline(anchor, label, options, depth + 1);
    parent.append(anchor);
    return;
  }

  const url = safeURL(href, options.baseURL);
  if (!url) {
    appendText(parent, label);
    return;
  }
  if (image) {
    const link = node('a', label || '查看图片');
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    parent.append(link);
    return;
  }
  const internal = options.documentHref?.(url);
  const link = node('a');
  link.href = internal || url.href;
  if (!internal) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  inline(link, label, options, depth + 1);
  parent.append(link);
}

const inlinePattern = /\\([\\`*_{}\[\]()#+\-.!|>~])|(`+)([^\n]+?)\2(?!`)|(!?)\[((?:\\.|[^\]\\])*)\]\(<?((?:\\.|\([^()\s]*\)|[^\s()>\\])+)>?(?:\s+["'][^\n]*?["'])?\)|(!?)\[((?:\\.|[^\]\\])*)\]\[([^\]]*)\]|<((?:https?:\/\/)[^ <>]+)>|(\*\*|__|~~)([^\n]+?)\11|([*_])([^\n]+?)\13/g;

function inline(parent, value, options, depth = 0) {
  if (depth > 8) {
    appendText(parent, value);
    return;
  }
  let position = 0;
  for (const match of value.matchAll(inlinePattern)) {
    appendText(parent, value.slice(position, match.index));
    if (match[1]) {
      appendText(parent, match[1]);
    } else if (match[2]) {
      parent.append(node('code', match[3].trim()));
    } else if (match[5] !== undefined) {
      appendLink(parent, match[5], match[6].replace(/\\([()])/g, '$1'), options, depth, match[4]);
    } else if (match[8] !== undefined) {
      const reference = (match[9] || match[8]).trim().toLowerCase();
      const href = options.references.get(reference);
      if (href) appendLink(parent, match[8], href, options, depth, match[7]);
      else appendText(parent, match[0]);
    } else if (match[10]) {
      appendLink(parent, match[10], match[10], options, depth, false);
    } else if (match[11]) {
      const element = node(match[11] === '~~' ? 'del' : 'strong');
      inline(element, match[12], options, depth + 1);
      parent.append(element);
    } else if (match[13]) {
      const before = value[match.index - 1] || '';
      const after = value[match.index + match[0].length] || '';
      if (match[13] === '_' && /[\p{L}\p{N}]/u.test(before + after)) {
        appendText(parent, match[0]);
      } else {
        const element = node('em');
        inline(element, match[14], options, depth + 1);
        parent.append(element);
      }
    }
    position = match.index + match[0].length;
  }
  appendText(parent, value.slice(position));
}

const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/;
const fence = /^ {0,3}(`{3,}|~{3,})\s*([^\s`~]*)/;
const listItem = /^(\s*)([-+*]|\d+[.)])\s+(.+)$/;
const rule = /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const quote = /^ {0,3}>\s?(.*)$/;
const tableDivider = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/;
const setext = /^ {0,3}(=+|-+)\s*$/;

function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/).map(cell => cell.trim());
}

function isBlockStart(lines, index) {
  const line = lines[index] || '';
  return !line.trim() || heading.test(line) || fence.test(line) || rule.test(line) ||
    quote.test(line) || listItem.test(line) ||
    (line.includes('|') && tableDivider.test(lines[index + 1] || ''));
}

function blockCode(parent, lines, language = '') {
  const block = node('div');
  block.className = 'code-block';
  const bar = node('div');
  bar.className = 'code-bar';
  bar.append(node('span', language || 'text'));
  const copy = node('button', '复制');
  copy.type = 'button';
  copy.className = 'code-copy';
  copy.dataset.action = 'copy-code';
  bar.append(copy);
  const pre = node('pre');
  pre.append(node('code', lines.join('\n')));
  block.append(bar, pre);
  parent.append(block);
}

function makeHeading(parent, text, level, options, lineNumber) {
  const element = node('h' + Math.max(2, level));
  inline(element, text, options);
  const plain = element.textContent;
  const section = options.sectionsByLine.get(lineNumber);
  const slug = plain.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\s-]/gu, '').replace(/\s/g, '-');
  let anchor = section?.anchor || slug || 'section';
  if (!section) {
    const base = anchor;
    for (let duplicate = 1; options.anchors.has(anchor); duplicate++) anchor = base + '-' + duplicate;
    options.anchors.add(anchor);
  }
  element.id = 'dsh-section-' + anchor;
  if (!options.hideTitle || level !== 1 || plain !== options.hideTitle) parent.append(element);
  else {
    const marker = node('span');
    marker.id = element.id;
    marker.className = 'document-title-anchor';
    marker.setAttribute('aria-hidden', 'true');
    parent.append(marker);
  }
}

function makeTable(parent, rows, divider, options) {
  const wrapper = node('div');
  wrapper.className = 'table-scroll';
  const table = node('table');
  const head = node('thead');
  const body = node('tbody');
  const alignment = tableCells(divider).map(value => {
    if (value.endsWith(':')) return value.startsWith(':') ? 'center' : 'right';
    return 'left';
  });
  const columns = tableCells(rows[0]).length;
  rows.forEach((line, index) => {
    const row = node('tr');
    const cells = tableCells(line);
    for (let column = 0; column < columns; column++) {
      const cell = node(index === 0 ? 'th' : 'td');
      if (index === 0) cell.scope = 'col';
      if (alignment[column]) cell.style.textAlign = alignment[column];
      inline(cell, cells[column] || '', options);
      row.append(cell);
    }
    (index === 0 ? head : body).append(row);
  });
  table.append(head, body);
  wrapper.append(table);
  parent.append(wrapper);
}

function makeList(parent, lines, start, options, depth) {
  const first = lines[start].match(listItem);
  const indent = first[1].length;
  const ordered = /^\d/.test(first[2]);
  const list = node(ordered ? 'ol' : 'ul');
  if (ordered) list.start = Number.parseInt(first[2], 10);

  let index = start;
  while (index < lines.length) {
    const current = lines[index].match(listItem);
    if (!current || current[1].length !== indent || /^\d/.test(current[2]) !== ordered) break;
    const item = node('li');
    const task = current[3].match(/^\[([xX ])\]\s+(.*)$/);
    if (task) {
      item.className = 'task-item';
      const checkbox = node('input');
      checkbox.type = 'checkbox';
      checkbox.disabled = true;
      checkbox.checked = task[1].toLowerCase() === 'x';
      checkbox.setAttribute('aria-label', checkbox.checked ? '已完成' : '未完成');
      item.append(checkbox);
    }
    inline(item, task ? task[2] : current[3], options);
    index++;
    const continuation = [];
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim() && (lines[index + 1]?.match(/^\s*/)?.[0].length || 0) > indent) {
        continuation.push('');
      } else if (line.trim() && (line.match(/^\s*/)?.[0].length || 0) > indent) {
        continuation.push(line.slice(indent + 2));
      } else {
        break;
      }
      index++;
    }
    if (continuation.length) blocks(item, continuation, options, depth + 1);
    list.append(item);
  }
  parent.append(list);
  return index;
}

function blocks(parent, lines, options, depth = 0) {
  if (depth > 20) {
    parent.append(node('pre', lines.join('\n')));
    return;
  }
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const openingFence = line.match(fence);
    const atx = line.match(heading);
    if (!line.trim()) {
      index++;
    } else if (openingFence) {
      const marker = openingFence[1];
      const content = [];
      const closingFence = new RegExp('^ {0,3}' + marker[0] + '{' + marker.length + ',}\\s*$');
      index++;
      while (index < lines.length && !closingFence.test(lines[index])) content.push(lines[index++]);
      if (index < lines.length) index++;
      blockCode(parent, content, openingFence[2]);
    } else if (atx) {
      const text = (atx[2] || '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim();
      makeHeading(parent, text, atx[1].length, options, depth ? undefined : index + 1);
      index++;
    } else if (line.includes('|') && tableDivider.test(lines[index + 1] || '')) {
      const rows = [line];
      const divider = lines[index + 1];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(lines[index++]);
      }
      makeTable(parent, rows, divider, options);
    } else if (setext.test(lines[index + 1] || '') && !isBlockStart(lines, index)) {
      makeHeading(parent, line.trim(), lines[index + 1].trim().startsWith('=') ? 1 : 2, options, depth ? undefined : index + 1);
      index += 2;
    } else if (rule.test(line)) {
      parent.append(node('hr'));
      index++;
    } else if (quote.test(line)) {
      const content = [];
      while (index < lines.length && quote.test(lines[index])) content.push(lines[index++].match(quote)[1]);
      const block = node('blockquote');
      blocks(block, content, options, depth + 1);
      parent.append(block);
    } else if (listItem.test(line)) {
      index = makeList(parent, lines, index, options, depth);
    } else if (/^(?: {4}|\t)/.test(line)) {
      const content = [];
      while (index < lines.length && /^(?: {4}|\t)/.test(lines[index])) {
        content.push(lines[index++].replace(/^(?: {4}|\t)/, ''));
      }
      blockCode(parent, content);
    } else {
      const paragraph = node('p');
      let previous = line;
      inline(paragraph, line.trim(), options);
      index++;
      while (index < lines.length && !isBlockStart(lines, index)) {
        if (/ {2}$|\\$/.test(previous)) paragraph.append(node('br'));
        else appendText(paragraph, ' ');
        previous = lines[index++];
        inline(paragraph, previous.trim(), options);
      }
      parent.append(paragraph);
    }
  }
}

export function renderMarkdown(markdown, options = {}) {
  const fragment = document.createDocumentFragment();
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const references = new Map();
  let activeFence = '';
  for (let index = 0; index < lines.length; index++) {
    const opening = lines[index].match(fence);
    if (opening) {
      if (!activeFence) activeFence = opening[1];
      else if (opening[1].startsWith(activeFence) && !opening[2]) activeFence = '';
    }
    if (activeFence) continue;
    const definition = lines[index].match(/^ {0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?(?:\s+["'].*["'])?\s*$/);
    if (definition) {
      references.set(definition[1].trim().toLowerCase(), definition[2]);
      lines[index] = '';
    }
  }
  const sections = options.sections || [];
  blocks(fragment, lines, {
    ...options,
    sectionsByLine: new Map(sections.map(section => [section.startLine, section])),
    anchors: new Set(sections.map(section => section.anchor)),
    references,
  });
  return fragment;
}
