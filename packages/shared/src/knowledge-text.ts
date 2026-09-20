/**
 * Pure text processing for the knowledge base (Phase 8): a Markdown-aware chunker, a tokenizer and a
 * deterministic local embedder. No I/O and no Node APIs, so the API, the worker and the tests all use
 * exactly the same code.
 */

// ---- Chunking --------------------------------------------------------------------------------

export interface KnowledgeChunkDraft {
  ordinal: number;
  /** The document title and the headings above this chunk, joined with " › ". Searched with the text. */
  heading: string;
  content: string;
}

/** Aim for roughly 500 tokens (about 2 000 characters) per chunk. */
export const CHUNK_TARGET_CHARS = 2000;
/** Carried from the end of one split chunk into the next so a sentence cut in half is still found. */
export const CHUNK_OVERLAP_CHARS = 200;
/** Sections shorter than this are merged into the section after them instead of standing alone. */
const MIN_SECTION_CHARS = 60;
/** A hard ceiling so one huge document cannot create an unbounded number of rows. */
export const MAX_CHUNKS_PER_DOCUMENT = 200;

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/;
const FENCE = /^\s{0,3}(```|~~~)/;

interface Section {
  path: string[];
  lines: string[];
}

/** Split Markdown into sections at headings, ignoring "headings" inside fenced code blocks. */
function sections(markdown: string): Section[] {
  const result: Section[] = [];
  const stack: { level: number; text: string }[] = [];
  let current: Section = { path: [], lines: [] };
  let fence: string | null = null;

  const flush = () => {
    if (current.lines.some((line) => line.trim() !== '')) result.push(current);
  };

  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1]!;
      else if (fenceMatch[1] === fence) fence = null;
    }
    const heading = fence === null ? HEADING.exec(line) : null;
    if (heading) {
      flush();
      const level = heading[1]!.length;
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, text: heading[2]!.trim() });
      current = { path: stack.map((entry) => entry.text), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  flush();
  return result;
}

/** Split an over-long body on paragraph boundaries (then hard, if a paragraph is itself too long). */
function splitBody(body: string): string[] {
  if (body.length <= CHUNK_TARGET_CHARS) return [body];
  const pieces: string[] = [];
  let buffer = '';
  const push = () => {
    if (buffer.trim() !== '') pieces.push(buffer.trim());
    buffer = '';
  };
  const add = (text: string) => {
    if (buffer.length > 0 && buffer.length + text.length + 2 > CHUNK_TARGET_CHARS) {
      const tail = buffer.slice(-CHUNK_OVERLAP_CHARS);
      push();
      buffer = tail;
    }
    buffer = buffer.length > 0 ? `${buffer}\n\n${text}` : text;
  };
  for (const paragraph of body.split(/\n{2,}/)) {
    if (paragraph.length <= CHUNK_TARGET_CHARS) {
      add(paragraph);
      continue;
    }
    for (let i = 0; i < paragraph.length; i += CHUNK_TARGET_CHARS - CHUNK_OVERLAP_CHARS) {
      add(paragraph.slice(i, i + CHUNK_TARGET_CHARS));
    }
  }
  push();
  return pieces;
}

/**
 * Heading-based chunks of a Markdown document. Each chunk knows where it sits ("Title › Setup ›
 * Restarting"), so a search hit can say which part of a runbook matched. Deterministic: the same
 * input always gives the same chunks, which is what lets unchanged chunks keep their embeddings.
 */
export function chunkMarkdown(title: string, markdown: string): KnowledgeChunkDraft[] {
  const chunks: KnowledgeChunkDraft[] = [];
  let carry: { path: string[]; text: string } | null = null;

  const emit = (path: string[], text: string) => {
    for (const piece of splitBody(text)) {
      chunks.push({
        ordinal: chunks.length,
        heading: [title, ...path].join(' › '),
        content: piece,
      });
    }
  };

  for (const section of sections(markdown)) {
    let text = section.lines.join('\n').trim();
    if (carry) {
      // A tiny section (often just a heading and a line) rides along with the one after it, keeping
      // its own heading as a line of text so it stays findable.
      const label = carry.path[carry.path.length - 1];
      text = [label, carry.text, text].filter((part) => part && part !== '').join('\n\n');
      carry = null;
    }
    if (text.length < MIN_SECTION_CHARS) {
      carry = { path: section.path, text };
      continue;
    }
    emit(section.path, text);
  }
  if (carry) {
    const label = carry.path[carry.path.length - 1];
    const text = [label, carry.text].filter((part) => part && part !== '').join('\n\n');
    if (text !== '') emit(carry.path, text);
  }

  // A document with no body at all is still findable by its title.
  if (chunks.length === 0) chunks.push({ ordinal: 0, heading: title, content: title });
  return chunks.slice(0, MAX_CHUNKS_PER_DOCUMENT);
}

// ---- Tokenizing ------------------------------------------------------------------------------

const STOP_WORDS = new Set(
  (
    'a an and are as at be but by for from has have he her his i if in into is it its of on or ' +
    'our she that the their them then there these they this to was we were what when where which ' +
    'who will with you your not no do does did so than too very can could should would may might'
  ).split(' '),
);

/** Lowercase words and identifiers (`http_500`, `db-primary`), without stop words. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu)) {
    const token = match[0]!.replace(/[_-]+$/, '');
    if (token.length >= 2 && !STOP_WORDS.has(token)) tokens.push(token);
  }
  return tokens;
}

// ---- Local embedding -------------------------------------------------------------------------

/**
 * Must match the `vector(N)` column. A remote provider has to return exactly this many numbers
 * (for example a 384-dimension model such as all-MiniLM).
 */
export const EMBEDDING_DIMENSIONS = 384;

/** Identifies the local embedder; stored per chunk so vectors from different providers never mix. */
export const LOCAL_EMBEDDING_MODEL = 'local-hash-v1';

/** 32-bit FNV-1a. Stable across platforms and runs, which is the whole point. */
function fnv1a(text: string, seed = 0x811c9dc5): number {
  let hash = seed;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A deterministic, dependency-free embedding: signed feature hashing of words, word pairs and
 * character trigrams into a fixed-size vector, normalised to unit length.
 *
 * What it is: text with overlapping vocabulary, related word forms ("restart" and "restarting") and
 * shared phrasing ends up close together, and it tolerates small typos. What it is NOT: it does not
 * know that "outage" and "downtime" mean the same thing. That needs a trained model, which is what
 * the optional remote provider is for. It exists so search works, offline and free, with no setup.
 */
export function embedLocally(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const counts = new Map<string, number>();
  const bump = (feature: string) => counts.set(feature, (counts.get(feature) ?? 0) + 1);

  const tokens = tokenize(text);
  tokens.forEach((token, index) => {
    bump(`w:${token}`);
    const next = tokens[index + 1];
    if (next) bump(`b:${token} ${next}`);
    if (token.length >= 5) {
      const padded = `^${token}$`;
      for (let i = 0; i + 3 <= padded.length; i += 1) bump(`c:${padded.slice(i, i + 3)}`);
    }
  });

  for (const [feature, count] of counts) {
    // Words matter most, pairs a little less, character pieces least (they only add fuzziness).
    const weight = feature.startsWith('w:') ? 1 : feature.startsWith('b:') ? 0.7 : 0.25;
    const hash = fnv1a(feature);
    const sign = fnv1a(feature, 0x9747b28c) & 1 ? 1 : -1;
    vector[hash % EMBEDDING_DIMENSIONS]! += sign * weight * (1 + Math.log(count));
  }

  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  return norm === 0 ? vector : vector.map((x) => x / norm);
}

/** Cosine similarity of two vectors of equal length (0 when either is all zeros). */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** The text a chunk is embedded as: where it sits, then what it says. */
export const embeddingInput = (chunk: { heading: string; content: string }): string =>
  `${chunk.heading}\n${chunk.content}`;

// ---- Snippets --------------------------------------------------------------------------------

/**
 * A short plain-text excerpt of `content` around the first query term that appears in it, so a
 * result shows why it matched. Never contains markup: the UI escapes and highlights it.
 */
export function makeSnippet(content: string, query: string, maxLength = 240): string {
  const flat = content
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= maxLength) return flat;
  const lower = flat.toLowerCase();
  let at = -1;
  for (const term of tokenize(query)) {
    at = lower.indexOf(term);
    if (at >= 0) break;
  }
  const start = Math.max(0, at < 0 ? 0 : at - Math.floor(maxLength / 4));
  const slice = flat.slice(start, start + maxLength).trim();
  return `${start > 0 ? '…' : ''}${slice}${start + maxLength < flat.length ? '…' : ''}`;
}
