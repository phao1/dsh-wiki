const escapePattern = /\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g;
const atxPattern = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/;
const setextPattern = /^ {0,3}(?:=+|-+)[ \t]*$/;

export function normalizeMarkdown(markdown) {
  return markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function unescapeMarkdown(text) {
  return text.replace(escapePattern, '$1');
}

function yamlParts(value, separator) {
  const parts = [];
  let start = 0;
  let quote = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quote) {
      if (quote === '"' && character === '\\') index++;
      else if (quote === "'" && character === "'" && value[index + 1] === "'") index++;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '#' && (index === 0 || /\s/.test(value[index - 1]))) {
      value = value.slice(0, index);
      break;
    }
    if ((character === '"' || character === "'") && (index === 0 || /[\s,\[]/.test(value[index - 1]))) {
      quote = character;
    } else if (character === separator) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function yamlValue(value) {
  const [scalar] = yamlParts(value);
  if (!scalar || scalar === '~' || /^(?:null)$/i.test(scalar)) return null;
  if (scalar.startsWith('[') && scalar.endsWith(']')) {
    return yamlParts(scalar.slice(1, -1), ',').map(yamlValue).filter(value => value != null);
  }
  if (scalar.startsWith("'") && scalar.endsWith("'")) return scalar.slice(1, -1).replace(/''/g, "'");
  if (scalar.startsWith('"') && scalar.endsWith('"')) {
    try {
      return JSON.parse(scalar);
    } catch {
      return scalar.slice(1, -1);
    }
  }
  return scalar;
}

function parseFrontmatter(lines) {
  const frontmatter = Object.create(null);
  for (let index = 0; index < lines.length; index++) {
    const match = /^([\w-]+):(?:[ \t]*(.*))?$/.exec(lines[index]);
    if (!match) continue;
    const [, key, raw = ''] = match;
    const value = yamlValue(raw);
    if (/^\s*(?:#.*)?$/.test(raw)) {
      const values = [];
      while (/^\s*-\s+/.test(lines[index + 1] ?? '')) {
        values.push(yamlValue(lines[++index].replace(/^\s*-\s+/, '')));
      }
      frontmatter[key] = values.length ? values.filter(value => value != null) : null;
    } else if (typeof value === 'string' && /^[|>][+-]?$/.test(value)) {
      const block = [];
      while (/^[ \t]+\S|^[ \t]*$/.test(lines[index + 1] ?? 'x')) {
        block.push(lines[++index].trim());
      }
      frontmatter[key] = block.join(value.startsWith('|') ? '\n' : ' ').trim();
    } else {
      frontmatter[key] = value;
    }
  }
  return frontmatter;
}

function codeLines(lines) {
  let fence = null;
  return lines.map(line => {
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) fence = null;
      return true;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening && (opening[1][0] === '~' || !opening[2].includes('`'))) {
      fence = opening[1];
      return true;
    }
    return /^(?: {4}| {0,3}\t)/.test(line);
  });
}

function headingAnchor(title, used, counts) {
  const base = title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\s-]/gu, '').replace(/\s/g, '-') || 'section';
  let duplicate = counts.get(base) ?? 0;
  let anchor = duplicate ? `${base}-${duplicate}` : base;
  while (used.has(anchor)) anchor = `${base}-${++duplicate}`;
  counts.set(base, duplicate + 1);
  used.add(anchor);
  return anchor;
}

function parseSections(lines, code) {
  const headings = [];
  let title = null;
  for (let index = 0; index < lines.length; index++) {
    if (code[index]) continue;
    const atx = atxPattern.exec(lines[index]);
    if (atx) {
      const heading = plainText((atx[2] ?? '').replace(/(?:^|[ \t]+)#+[ \t]*$/, ''));
      headings.push({ title: heading, index });
      if (title === null && atx[1] === '#' && heading) title = heading;
    } else if (lines[index].trim() && !/^ {0,3}(?:>|[-+*][ \t]|\d+[.)][ \t]|\[.+\]:|<)/.test(lines[index]) && setextPattern.test(lines[index + 1] ?? '')) {
      const heading = plainText(lines[index]);
      headings.push({ title: heading, index });
      if (title === null && lines[index + 1].trimStart().startsWith('=') && heading) title = heading;
      index++;
    }
  }

  const used = new Set();
  const counts = new Map();
  for (const heading of headings) heading.anchor = headingAnchor(heading.title, used, counts);
  if (lines.slice(0, headings[0]?.index ?? lines.length).some(line => line.trim())) {
    headings.unshift({ title: 'Overview', anchor: headingAnchor('Overview', used, counts), index: 0 });
  }
  const sections = headings.map((heading, index) => {
    const endLine = headings[index + 1]?.index ?? lines.length;
    return {
      anchor: heading.anchor,
      title: heading.title,
      startLine: heading.index + 1,
      endLine,
      body: lines.slice(heading.index, endLine).join('\n'),
    };
  });
  return { title, sections };
}

function withoutInlineCode(text) {
  return text.replace(/(?<![\\`])(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g, ' ');
}

function referenceKey(label) {
  return unescapeMarkdown(label).trim().replace(/\s+/g, ' ').toLowerCase();
}

function readDestination(text) {
  if (text.startsWith('<')) {
    const angle = /^<((?:\\.|[^<>\\])*)>/.exec(text);
    if (angle) return { target: unescapeMarkdown(angle[1]), rest: text.slice(angle[0].length) };
    return null;
  }

  let index = 0;
  let depth = 0;
  for (; index < text.length; index++) {
    const character = text[index];
    if (character === '\\' && index + 1 < text.length) index++;
    else if (/\s/.test(character) || (character === ')' && depth === 0)) break;
    else if (character === '(') depth++;
    else if (character === ')') depth--;
  }
  return depth === 0 ? { target: unescapeMarkdown(text.slice(0, index)), rest: text.slice(index) } : null;
}

function parseTargets(lines, code) {
  const references = new Map();
  const visible = [];
  lines.forEach((line, index) => {
    if (code[index]) return;
    const definition = /^ {0,3}\[((?:\\.|[^\]\\])+)\]:[ \t]*(.+)$/.exec(line);
    if (definition) {
      const destination = readDestination(definition[2]);
      const key = referenceKey(definition[1]);
      if (destination?.target && !references.has(key)) references.set(key, destination.target);
    } else {
      visible.push(withoutInlineCode(line));
    }
  });

  const targets = new Set();
  for (let line of visible) {
    line = line.replace(/(?<!\\)\[\[([^\]\n]+)\]\]/g, (_match, label) => {
      targets.add(label.split('|', 1)[0].trim());
      return ' ';
    });
    for (const label of line.matchAll(/(?<!\\)(!?)\[((?:\\.|[^\[\]\\]|\[[^\[\]\n]*\])*)\](?:\[((?:\\.|[^\]\\])*)\])?/g)) {
      if (label[1]) continue;
      const suffix = line.slice(label.index + label[0].length);
      if (label[3] === undefined && suffix.startsWith('(')) {
        const destination = readDestination(suffix.slice(1).trimStart());
        if (destination?.target && /^(?:\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\([^)]*\)))?\s*\)/.test(destination.rest)) {
          targets.add(destination.target);
        }
      } else {
        const target = references.get(referenceKey(label[3] || label[2]));
        if (target) targets.add(target);
      }
    }
    for (const match of line.matchAll(/<(https?:\/\/[^\s<>]+)>/gi)) targets.add(match[1]);
  }
  targets.delete('');
  return [...targets];
}

export function parseMarkdown(markdown) {
  const normalized = normalizeMarkdown(markdown);
  const lines = normalized.split('\n');
  let end = /^---[ \t]*$/.test(lines[0]) ? lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line)) : -1;
  if (end > 0 && lines.slice(1, end).some(line => !/^(?:\s|[\w-]+:|#|-[ \t]|$)/.test(line))) end = -1;
  const frontmatter = end < 0 ? Object.create(null) : parseFrontmatter(lines.slice(1, end));
  const bodyLines = lines.slice(end + 1);
  const body = bodyLines.join('\n');
  if (bodyLines.at(-1) === '') bodyLines.pop();
  const code = codeLines(bodyLines);
  const { title, sections } = parseSections(bodyLines, code);
  return { frontmatter, body, title, sections, targets: parseTargets(bodyLines, code) };
}

export function plainText(text) {
  return unescapeMarkdown(text
    .replace(/^ {0,3}\[(?:\\.|[^\]\\])+\]:[^\n]*$/gm, ' ')
    .replace(/^(?: {0,3})(?:#{1,6}|>|[-+*]|\d+[.)])(?:[ \t]+|$)/gm, '')
    .replace(/^[ \t]*(?:`{3,}|~{3,}).*$/gm, ' ')
    .replace(/!?\[([^\[\]\n]+)\]\((?:<[^>]*>|(?:[^()\n]|\([^()\n]*\))*)\)/g, '$1')
    .replace(/!?\[([^\[\]\n]+)\]\[[^\[\]\n]*\]/g, '$1')
    .replace(/\[\[([^|\]\n]+)(?:\|([^\]\n]+))?\]\]/g, (_match, target, label) => label || target)
    .replace(/<\/?[A-Za-z][\w-]*(?:\s[^>]*?)?\s*\/?>/g, '')
    .replace(/(?<!\\)(`+)(.*?)\1/g, '$2')
    .replace(/\*{1,3}([^*\n]+)\*{1,3}|(?<!\w)_{1,3}([^_\n]+)_{1,3}(?!\w)|~~([^~\n]+)~~/g, (_match, bold, italic, strike) => bold || italic || strike))
    .replace(/\s+/g, ' ').trim();
}

export function estimateTokens(text) {
  let tokens = 0;
  for (const [run] of text.matchAll(/[A-Za-z0-9_]+|\s+|[^\s]/gu)) {
    if (/[A-Za-z0-9_]/.test(run[0])) tokens += Math.ceil(run.length / 4);
    else if (/\s/.test(run[0])) tokens += run === ' ' ? 0 : Math.ceil(run.length / 4);
    else tokens++;
  }
  return tokens;
}
