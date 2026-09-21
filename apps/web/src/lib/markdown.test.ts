import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, safeHref, splitHighlight, type Block } from './markdown';

describe('safeHref', () => {
  it('allows web and mail links only', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeHref('http://example.com')).toBe('http://example.com');
    expect(safeHref('mailto:ops@example.com')).toBe('mailto:ops@example.com');
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:x',
      'file:///etc/passwd',
      '//evil.example.com',
      '/relative',
      'https://a b',
      '',
      ' javascript:alert(1)',
    ]) {
      expect(safeHref(bad), bad).toBeNull();
    }
  });
});

describe('parseInline', () => {
  it('parses code, bold, emphasis and links', () => {
    expect(parseInline('run `make up` **now** and *soon* see [docs](https://x.io)')).toEqual([
      { t: 'text', text: 'run ' },
      { t: 'code', text: 'make up' },
      { t: 'text', text: ' ' },
      { t: 'strong', children: [{ t: 'text', text: 'now' }] },
      { t: 'text', text: ' and ' },
      { t: 'em', children: [{ t: 'text', text: 'soon' }] },
      { t: 'text', text: ' see ' },
      { t: 'link', href: 'https://x.io', children: [{ t: 'text', text: 'docs' }] },
    ]);
  });

  it('keeps the words of a link with an unsafe target and drops the link', () => {
    expect(parseInline('[click](javascript:alert(1))')).toEqual([{ t: 'text', text: 'click' }]);
  });

  it('never turns markup into anything but text', () => {
    const nodes = parseInline('<script>alert(1)</script><img src=x onerror=alert(1)>');
    expect(nodes).toEqual([
      { t: 'text', text: '<script>alert(1)</script><img src=x onerror=alert(1)>' },
    ]);
  });

  it('leaves unbalanced markers as text and cannot recurse without bound', () => {
    expect(parseInline('**unclosed')).toEqual([{ t: 'text', text: '**unclosed' }]);
    expect(parseInline('`unclosed')).toEqual([{ t: 'text', text: '`unclosed' }]);
    const deep = '*'.repeat(500) + 'x' + '*'.repeat(500);
    expect(() => parseInline(deep)).not.toThrow();
    expect(() => parseInline('['.repeat(2000))).not.toThrow();
  });
});

describe('parseMarkdown', () => {
  const doc = [
    '# Restart',
    'Watch the **error rate**.',
    '',
    '## Steps',
    '1. Drain traffic',
    '2. Restart',
    '',
    '- a',
    '- b',
    '',
    '> careful',
    '',
    '---',
    '```bash',
    '# not a heading',
    'systemctl restart app',
    '```',
  ].join('\n');

  it('recognises each block type', () => {
    const blocks = parseMarkdown(doc);
    expect(blocks.map((b) => b.t)).toEqual([
      'heading',
      'paragraph',
      'heading',
      'list',
      'list',
      'quote',
      'rule',
      'code',
    ]);
    expect((blocks[3] as Extract<Block, { t: 'list' }>).ordered).toBe(true);
    expect((blocks[4] as Extract<Block, { t: 'list' }>).ordered).toBe(false);
    expect(blocks[7]).toEqual({
      t: 'code',
      lang: 'bash',
      text: '# not a heading\nsystemctl restart app',
    });
  });

  it('joins wrapped lines into one paragraph', () => {
    expect(parseMarkdown('one\ntwo\n\nthree')).toEqual([
      { t: 'paragraph', children: [{ t: 'text', text: 'one two' }] },
      { t: 'paragraph', children: [{ t: 'text', text: 'three' }] },
    ]);
  });

  it('treats an unterminated code fence as code to the end, without throwing', () => {
    expect(parseMarkdown('```\nabc')).toEqual([{ t: 'code', lang: '', text: 'abc' }]);
  });

  it('handles Windows line endings, empty input and hostile input', () => {
    expect(parseMarkdown('# A\r\ntext')).toHaveLength(2);
    expect(parseMarkdown('')).toEqual([]);
    expect(() => parseMarkdown('#'.repeat(10_000) + '\n' + '- '.repeat(10_000))).not.toThrow();
  });
});

describe('splitHighlight', () => {
  it('marks words of the query, case-insensitively', () => {
    expect(splitHighlight('Restart the Checkout service', 'checkout restart')).toEqual([
      { text: 'Restart', match: true },
      { text: ' the ', match: false },
      { text: 'Checkout', match: true },
      { text: ' service', match: false },
    ]);
  });

  it('returns the text untouched when nothing can match, and escapes regex characters', () => {
    expect(splitHighlight('plain text', '')).toEqual([{ text: 'plain text', match: false }]);
    expect(() => splitHighlight('a (b) [c]', '.*+?^${}()|[]\\ (b)')).not.toThrow();
    expect(splitHighlight('x', 'zzz')).toEqual([{ text: 'x', match: false }]);
  });
});

describe('links with parentheses', () => {
  it('keeps a legitimate URL that contains parentheses', () => {
    expect(parseInline('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual([
      {
        t: 'link',
        href: 'https://en.wikipedia.org/wiki/Foo_(bar)',
        children: [{ t: 'text', text: 'wiki' }],
      },
    ]);
  });
});

describe('worst-case input', () => {
  it('finishes quickly on pathological lines instead of freezing the tab', () => {
    const started = Date.now();
    for (const line of [
      '*'.repeat(200_000),
      '['.repeat(200_000),
      '`'.repeat(200_000),
      '_a'.repeat(100_000),
    ]) {
      parseMarkdown(line);
    }
    parseMarkdown(Array.from({ length: 5000 }, () => '**a* '.repeat(50)).join('\n'));
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('shows an over-long line as plain text', () => {
    const long = `**bold** ${'x'.repeat(5000)}`;
    expect(parseInline(long)).toEqual([{ t: 'text', text: long }]);
  });
});
