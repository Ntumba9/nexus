/**
 * A small, safe Markdown parser for runbooks. It produces a data structure, never HTML: the view
 * renders it as React elements, so nothing a document contains can become markup or script. Only
 * what runbooks actually need is supported (headings, paragraphs, lists, code, quotes, rules, and
 * inline code, bold, emphasis and links); everything else is shown as plain text.
 */

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'code'; text: string }
  | { t: 'strong'; children: Inline[] }
  | { t: 'em'; children: Inline[] }
  | { t: 'link'; href: string; children: Inline[] };

export type Block =
  | { t: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { t: 'paragraph'; children: Inline[] }
  | { t: 'list'; ordered: boolean; items: Inline[][] }
  | { t: 'code'; lang: string; text: string }
  | { t: 'quote'; children: Inline[] }
  | { t: 'rule' };

/** Only web and mail links are followed. `javascript:`, `data:` and the rest become plain text. */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (/^https?:\/\/[^\s]+$/i.test(url) || /^mailto:[^\s]+$/i.test(url)) return url;
  return null;
}

const MAX_NESTING = 4;

/**
 * One line longer than this is shown as plain text. Inline scanning is quadratic in the worst case
 * (a line of nothing but `*`), and a document must not be able to freeze a reader's tab.
 */
export const MAX_INLINE_CHARS = 4000;

export function parseInline(text: string, depth = 0): Inline[] {
  if (text.length > MAX_INLINE_CHARS) return [{ t: 'text', text }];
  const out: Inline[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer !== '') out.push({ t: 'text', text: buffer });
    buffer = '';
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m: RegExpExecArray | null;

    if ((m = /^`([^`\n]+)`/.exec(rest))) {
      flush();
      out.push({ t: 'code', text: m[1]! });
      i += m[0].length;
    } else if (depth < MAX_NESTING && (m = /^\*\*([^\n]+?)\*\*/.exec(rest))) {
      flush();
      out.push({ t: 'strong', children: parseInline(m[1]!, depth + 1) });
      i += m[0].length;
    } else if (
      depth < MAX_NESTING &&
      (m = /^(?:\*([^*\s][^*\n]*?)\*|_([^_\s][^_\n]*?)_)/.exec(rest))
    ) {
      flush();
      out.push({ t: 'em', children: parseInline(m[1] ?? m[2]!, depth + 1) });
      i += m[0].length;
    } else if (
      depth < MAX_NESTING &&
      (m = /^\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/.exec(rest))
    ) {
      const href = safeHref(m[2]!);
      if (href) {
        flush();
        out.push({ t: 'link', href, children: parseInline(m[1]!, depth + 1) });
      } else {
        // An unsafe target: keep the words, drop the link.
        buffer += m[1]!;
      }
      i += m[0].length;
    } else {
      buffer += text[i]!;
      i += 1;
    }
  }
  flush();
  return out;
}

const FENCE = /^\s{0,3}(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/;
const BULLET = /^\s{0,3}[-*+][ \t]+(.*)$/;
const NUMBERED = /^\s{0,3}\d{1,9}[.)][ \t]+(.*)$/;
const QUOTE = /^\s{0,3}>[ \t]?(.*)$/;
const RULE = /^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** Blocks of a document. Never throws: anything unrecognised becomes a paragraph of text. */
export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ t: 'paragraph', children: parseInline(paragraph.join(' ')) });
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    let m: RegExpExecArray | null;

    if ((m = FENCE.exec(line))) {
      flushParagraph();
      const marker = m[1]!;
      const lang = m[2] ?? '';
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(marker)) {
        body.push(lines[i]!);
        i += 1;
      }
      blocks.push({ t: 'code', lang, text: body.join('\n') });
    } else if (line.trim() === '') {
      flushParagraph();
    } else if ((m = HEADING.exec(line))) {
      flushParagraph();
      blocks.push({
        t: 'heading',
        level: m[1]!.length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(m[2]!),
      });
    } else if (RULE.test(line)) {
      flushParagraph();
      blocks.push({ t: 'rule' });
    } else if ((m = BULLET.exec(line)) || (m = NUMBERED.exec(line))) {
      flushParagraph();
      const ordered = NUMBERED.test(line) && !BULLET.test(line);
      const items: Inline[][] = [parseInline(m[1]!)];
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!;
        const item = ordered ? NUMBERED.exec(next) : BULLET.exec(next);
        if (!item) break;
        items.push(parseInline(item[1]!));
        i += 1;
      }
      blocks.push({ t: 'list', ordered, items });
    } else if ((m = QUOTE.exec(line))) {
      flushParagraph();
      const quoted = [m[1]!];
      while (i + 1 < lines.length && QUOTE.test(lines[i + 1]!)) {
        quoted.push(QUOTE.exec(lines[i + 1]!)![1]!);
        i += 1;
      }
      blocks.push({ t: 'quote', children: parseInline(quoted.join(' ')) });
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  return blocks;
}

/** Split `text` into runs, marking those that match a word of `query` (for search highlighting). */
export function splitHighlight(text: string, query: string): { text: string; match: boolean }[] {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [])]
    .filter((word) => word.length >= 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, 12);
  if (words.length === 0 || text === '') return [{ text, match: false }];
  const pattern = new RegExp(
    `(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'giu',
  );
  return text
    .split(pattern)
    .filter((part) => part !== '')
    .map((part) => ({ text: part, match: words.includes(part.toLowerCase()) }));
}
