import { plainText } from './markdown.mjs';

const WORDS = /\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}\p{M}])+/gu;
const HAN = /^\p{Script=Han}/u;
const STOP_WORDS = new Set(
  'a an and are as at be by for from how in is it of on or that the to what when where which with'.split(' '),
);
const CHINESE_WORDS = new Intl.Segmenter('zh', { granularity: 'word' });
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Title, metadata, section headings, and body, respectively.
const FIELDS = [
  { weight: 4, lengthWeight: 0.25, phraseBoost: 2.15 },
  { weight: 1.45, lengthWeight: 0.25, phraseBoost: 1.9 },
  { weight: 2, lengthWeight: 0.35, phraseBoost: 1.7 },
  { weight: 1, lengthWeight: 0.65, phraseBoost: 1.25 },
];
const SNIPPET_LENGTH = 180;

// DSH vocabulary for Chinese queries against its English documentation.
const QUERY_EXPANSIONS = [
  [['创建工具', '添加工具', '编写工具', '构建工具'], ['build a tool', 'adding a tool', 'tool authoring', 'tool plugin']],
  [['插件配置', '配置插件'], ['plugin configuration', 'define the config type', 'schema validation']],
  [['mcp记忆', 'mcp内存', '记忆mcp'], ['memory mcp', 'mcp memory', 'memorix', 'engram']],
  [['模型供应商', '模型提供商', '配置模型', '模型服务商'], ['configure models', 'third party provider', 'providers', 'custom model api']],
  [['网络代理', '配置代理'], ['network proxy', 'http proxy', 'https proxy', 'no proxy']],
  [['发布插件', '打包插件', '安装插件'], ['package and install a plugin', 'bundle manifest', 'profile manifest', 'publish plugin']],
  [['会话生命周期', '轮次生命周期', '智能体生命周期'], ['agent turn and step lifecycle', 'agent lifecycle', 'turn lifecycle']],
  [['并行工具', '工具并行', '并行调用工具'], ['parallel tool', 'raw call batches', 'tool executors', 'tool execution']],
];

const CONCEPT_EXPANSIONS = [
  ['插件', ['plugin', 'plugins']],
  ['配置', ['config', 'configuration', 'configure']],
  ['工具', ['tool', 'tools']],
  ['会话', ['session', 'sessions']],
  ['上下文', ['context']],
  ['权限', ['permission', 'permissions']],
  ['沙箱', ['sandbox', 'sandboxing']],
  ['取消', ['cancel', 'cancellation', 'abort']],
  ['模型', ['model', 'models']],
  ['并发', ['concurrent', 'concurrency', 'parallel']],
];

function fold(text) {
  return text.normalize('NFKC').toLowerCase();
}

function lexemes(text) {
  return fold(text).match(WORDS) ?? [];
}

function termPieces(word, includeSingles = false) {
  if (!HAN.test(word)) return [word];
  const characters = Array.from(word);
  if (characters.length === 1) return characters;

  const pieces = includeSingles ? [...characters] : [];
  for (let index = 1; index < characters.length; index++) {
    pieces.push(characters[index - 1] + characters[index]);
  }
  return pieces;
}

function makeField(text) {
  const words = lexemes(text);
  const counts = new Map();
  let length = 0;

  for (const word of words) {
    for (const term of termPieces(word, true)) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
      length++;
    }
  }

  return { counts, length, phraseText: ` ${words.join(' ')} ` };
}

function makePhrase(words) {
  const left = HAN.test(words[0]) ? '' : ' ';
  const right = HAN.test(words.at(-1)) ? '' : ' ';
  return left + words.join(' ') + right;
}

function makeQuery(query) {
  const allWords = lexemes(query);
  const significantWords = allWords.filter((word) => !STOP_WORDS.has(word));
  const words = significantWords.length ? significantWords : allWords;
  const terms = new Map();

  for (const word of words) {
    const pieces = termPieces(word);
    const weight = 1 / Math.sqrt(pieces.length);
    const preferred = new Set();
    if (pieces.length > 1) {
      let single = '';
      for (const { segment } of CHINESE_WORDS.segment(word)) {
        if (Array.from(segment).length === 1) {
          if (single) preferred.add(single + segment);
          single = segment;
        } else {
          for (const piece of termPieces(segment)) preferred.add(piece);
          single = '';
        }
      }
    }
    for (const term of pieces) {
      const pieceWeight = preferred.size && !preferred.has(term) ? weight * 0.35 : weight;
      terms.set(term, Math.max(pieceWeight, terms.get(term) ?? 0));
    }
  }

  const phrases = [];
  if (allWords.length && (allWords.length > 1 || HAN.test(allWords[0]))) {
    phrases.push({ text: makePhrase(allWords), weight: 1 });
  }

  const compact = allWords.join('');
  const matched = new Set(words);
  for (const [aliases, expansions] of QUERY_EXPANSIONS) {
    if (!aliases.some(alias => compact.includes(alias))) continue;
    for (const expansion of expansions) {
      const expandedWords = lexemes(expansion);
      phrases.push({ text: makePhrase(expandedWords), weight: 0.8 });
      for (const word of expandedWords) {
        if (STOP_WORDS.has(word)) continue;
        matched.add(word);
        terms.set(word, Math.max(0.5, terms.get(word) ?? 0));
      }
    }
  }
  for (const [concept, expansions] of CONCEPT_EXPANSIONS) {
    if (!compact.includes(concept)) continue;
    for (const word of expansions) {
      matched.add(word);
      terms.set(word, Math.max(0.25, terms.get(word) ?? 0));
    }
  }

  const totalWeight = [...terms.values()].reduce((sum, weight) => sum + weight, 0);
  return { words: [...matched], terms, totalWeight, phrases };
}

function phraseWeight(field, query) {
  let best = 0;
  for (const phrase of query.phrases) {
    if (phrase.weight > best && field.phraseText.includes(phrase.text)) best = phrase.weight;
  }
  return best;
}

export function createSearchIndex(documents) {
  const records = new Map();
  const postings = new Map();
  const totalLengths = FIELDS.map(() => 0);

  for (const document of documents) {
    const bodyText = plainText(document.body);
    const sections = document.sections.map((section) => {
      const text = plainText(section.body);
      return {
        anchor: section.anchor,
        title: section.title,
        text,
        heading: makeField(section.title),
        body: makeField(text),
      };
    });

    const fields = [
      makeField(document.title),
      makeField([document.path, document.category, ...document.tags].join(' ')),
      makeField(sections.map(({ title }) => title).join('\n')),
      makeField(bodyText),
    ];

    const documentTerms = new Set();
    for (const [index, field] of fields.entries()) {
      totalLengths[index] += field.length;
      for (const term of field.counts.keys()) documentTerms.add(term);
    }
    for (const term of documentTerms) {
      if (!postings.has(term)) postings.set(term, []);
      postings.get(term).push(document.id);
    }

    records.set(document.id, {
      id: document.id,
      title: document.title,
      fields,
      sections,
      bodyText,
    });
  }

  const averageLengths = totalLengths.map((length) => length / (records.size || 1) || 1);
  return { records, postings, averageLengths };
}

function bm25(count, length, averageLength, lengthWeight) {
  if (!count) return 0;
  const saturation = 1.2 * (1 - lengthWeight + lengthWeight * length / averageLength);
  return 2.2 * count / (count + saturation);
}

function relevance(record, query, terms, averageLengths) {
  let score = 0;
  let coverage = 0;

  for (const [term, weight] of terms) {
    let termScore = 0;
    for (const [index, field] of record.fields.entries()) {
      const { weight: fieldWeight, lengthWeight } = FIELDS[index];
      termScore += fieldWeight * bm25(
        field.counts.get(term) ?? 0,
        field.length,
        averageLengths[index],
        lengthWeight,
      );
    }

    if (termScore > 0) {
      score += weight * termScore;
      coverage += query.terms.get(term);
    }
  }

  score *= 0.35 + 0.65 * coverage / query.totalWeight;
  if (!query.phrases.length) return score;

  const phraseField = record.fields
    .map((field, index) => 1 + phraseWeight(field, query) * (FIELDS[index].phraseBoost - 1));
  return score * Math.max(...phraseField);
}

function bestSection(sections, query, terms) {
  let best = null;
  let bestScore = 0;

  for (const section of sections) {
    let score = 0;
    let coverage = 0;
    const bodyNormalization = 0.8 + 0.2 * section.body.length / 150;

    for (const [term, weight] of terms) {
      const headingCount = section.heading.counts.get(term) ?? 0;
      const bodyCount = section.body.counts.get(term) ?? 0;
      if (headingCount || bodyCount) coverage += query.terms.get(term);
      score += weight * (
        2.2 * bm25(headingCount, 1, 1, 0)
        + bodyCount / (bodyCount + bodyNormalization)
      );
    }
    score *= 0.6 + 0.4 * coverage / query.totalWeight;

    score *= 1 + Math.max(phraseWeight(section.heading, query) * 0.4, phraseWeight(section.body, query) * 0.25);

    if (score > bestScore) {
      best = section;
      bestScore = score;
    }
  }

  return best;
}

function matchedWords(record, query) {
  const matches = new Set();
  for (const word of query.words) {
    const phrase = makePhrase([word]);
    if (record.fields.some((field) => field.phraseText.includes(phrase))) {
      matches.add(word);
      continue;
    }
    for (const term of termPieces(word)) {
      if (record.fields.some((field) => field.counts.has(term))) matches.add(term);
    }
  }
  return [...matches];
}

function snippetFocus(text, query, terms) {
  // Find offsets in the original display text so case folding can never cut a character.
  const chineseTerms = new Map([...terms].filter(([term]) => HAN.test(term)));
  for (const word of query.words) {
    if (!HAN.test(word) || chineseTerms.has(word)) continue;
    const score = termPieces(word).reduce((sum, piece) => sum + (terms.get(piece) ?? 0), 0);
    if (score) chineseTerms.set(word, score);
  }
  let bestIndex = 0;
  let bestScore = 0;

  for (const match of text.matchAll(WORDS)) {
    const [original] = match;
    const folded = fold(original);
    if (HAN.test(folded)) {
      for (const [term, score] of chineseTerms) {
        if (score <= bestScore) continue;
        const offset = folded.indexOf(term);
        if (offset !== -1) {
          bestScore = score;
          bestIndex = match.index + (folded.length === original.length ? offset : 0);
        }
      }
    } else {
      const score = terms.get(folded) ?? 0;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = match.index;
      }
    }
  }
  return bestIndex;
}

function makeSnippet(text, query, terms) {
  if (text.length <= SNIPPET_LENGTH) return text;

  const focus = snippetFocus(text, query, terms);
  const start = Math.max(0, Math.min(focus - 55, text.length - SNIPPET_LENGTH));
  const end = start + SNIPPET_LENGTH;
  const graphemes = GRAPHEMES.segment(text);
  const safeStart = graphemes.containing(start).index;
  const safeEnd = end < text.length ? graphemes.containing(end).index : text.length;
  const content = text.slice(safeStart, safeEnd).trim();
  return (safeStart ? '…' : '') + content + (safeEnd < text.length ? '…' : '');
}

export function searchIndex(index, queryText, candidateIds) {
  const query = makeQuery(queryText);
  const terms = new Map();
  const matchingIds = new Set();

  for (const [term, weight] of query.terms) {
    const ids = index.postings.get(term);
    if (!ids) continue;
    const idf = Math.log1p((index.records.size - ids.length + 0.5) / (ids.length + 0.5));
    terms.set(term, idf * weight);
    for (const id of ids) {
      if (!candidateIds || candidateIds.has(id)) matchingIds.add(id);
    }
  }

  const hits = [...matchingIds].map((id) => {
    const record = index.records.get(id);
    return { record, score: relevance(record, query, terms, index.averageLengths) };
  });
  hits.sort((left, right) =>
    right.score - left.score
    || left.record.title.localeCompare(right.record.title, 'en')
    || left.record.id.localeCompare(right.record.id),
  );

  return hits.map(({ record, score }) => {
    const section = bestSection(record.sections, query, terms);
    const text = section?.text || section?.title || record.bodyText || record.title;
    return {
      id: record.id,
      score,
      snippet: makeSnippet(text, query, terms),
      sectionAnchor: section?.anchor ?? null,
      sectionTitle: section?.title ?? null,
      matchedTerms: matchedWords(record, query),
    };
  });
}
