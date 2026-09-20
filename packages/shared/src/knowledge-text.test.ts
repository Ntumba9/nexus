import { describe, expect, it } from 'vitest';
import {
  CHUNK_TARGET_CHARS,
  EMBEDDING_DIMENSIONS,
  MAX_CHUNKS_PER_DOCUMENT,
  chunkMarkdown,
  cosineSimilarity,
  embedLocally,
  embeddingInput,
  makeSnippet,
  tokenize,
} from './knowledge-text';

const para = (word: string, n: number) => Array.from({ length: n }, () => word).join(' ');

describe('chunkMarkdown', () => {
  it('splits at headings and records where each chunk sits', () => {
    const md = [
      '# Restart runbook',
      `${para('Check the dashboard before doing anything.', 3)}`,
      '## Rollback',
      `${para('Roll back the last deployment with the release tool.', 3)}`,
      '### Verify',
      `${para('Confirm error rates return to normal for ten minutes.', 3)}`,
    ].join('\n');
    const chunks = chunkMarkdown('Payments', md);
    expect(chunks.map((c) => c.heading)).toEqual([
      'Payments › Restart runbook',
      'Payments › Restart runbook › Rollback',
      'Payments › Restart runbook › Rollback › Verify',
    ]);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
    expect(chunks[1]!.content).toContain('Roll back');
  });

  it('does not treat "#" lines inside a code fence as headings', () => {
    const md = [
      '# Setup',
      'Run the following and watch the output for errors from the service.',
      '```bash',
      '# this is a comment, not a heading',
      'systemctl restart app',
      '```',
    ].join('\n');
    const chunks = chunkMarkdown('Doc', md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain('# this is a comment');
  });

  it('merges a tiny section into the next one rather than leaving a stub', () => {
    const md = ['# A', 'short', '# B', para('a reasonably long paragraph of runbook text', 4)].join(
      '\n',
    );
    const chunks = chunkMarkdown('Doc', md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain('short');
    expect(chunks[0]!.content).toContain('reasonably long');
  });

  it('splits a long section on paragraph boundaries with overlap, within the target size', () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${para('word', 60)}`);
    const chunks = chunkMarkdown('Doc', `# Long\n${paragraphs.join('\n\n')}`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS + 300);
    }
    // Overlap: the start of the second chunk repeats text from the end of the first.
    const tail = chunks[0]!.content.slice(-40);
    expect(chunks[1]!.content).toContain(tail.trim().split(' ').slice(-3).join(' '));
  });

  it('hard-splits a single enormous paragraph', () => {
    const chunks = chunkMarkdown('Doc', `# Blob\n${'x'.repeat(CHUNK_TARGET_CHARS * 3)}`);
    expect(chunks.length).toBeGreaterThan(2);
  });

  it('is deterministic', () => {
    const md = `# One\n${para('alpha beta gamma', 40)}\n# Two\n${para('delta epsilon', 40)}`;
    expect(chunkMarkdown('T', md)).toEqual(chunkMarkdown('T', md));
  });

  it('keeps an empty document findable by its title', () => {
    expect(chunkMarkdown('Empty runbook', '')).toEqual([
      { ordinal: 0, heading: 'Empty runbook', content: 'Empty runbook' },
    ]);
  });

  it('caps the number of chunks', () => {
    const md = Array.from({ length: 400 }, (_, i) => `# H${i}\n${para('body text here', 10)}`).join(
      '\n',
    );
    expect(chunkMarkdown('Big', md)).toHaveLength(MAX_CHUNKS_PER_DOCUMENT);
  });

  it('handles Windows line endings', () => {
    const md = `# A\r\n${para('some body text for the section', 5)}\r\n# B\r\n${para('other body text here', 5)}`;
    expect(chunkMarkdown('T', md)).toHaveLength(2);
  });
});

describe('tokenize', () => {
  it('lowercases, drops stop words and keeps identifiers', () => {
    expect(tokenize('The DB-primary is at HTTP_500 and it is down!')).toEqual([
      'db-primary',
      'http_500',
      'down',
    ]);
  });
  it('handles non-latin text', () => {
    expect(tokenize('Überprüfung der Datenbank')).toContain('überprüfung');
  });
});

describe('embedLocally', () => {
  it('returns a unit vector of the configured size', () => {
    const v = embedLocally('restart the payment service after rolling back');
    expect(v).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(Math.sqrt(v.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
  });

  it('is deterministic', () => {
    expect(embedLocally('database failover procedure')).toEqual(
      embedLocally('database failover procedure'),
    );
  });

  it('returns a zero vector (not NaN) when there is nothing to embed', () => {
    const v = embedLocally('the and of');
    expect(v.every((x) => x === 0)).toBe(true);
  });

  it('ranks related text above unrelated text', () => {
    const query = embedLocally('how do I restart the checkout service');
    const related = embedLocally('Restarting the checkout service: run the restart command');
    const unrelated = embedLocally('Quarterly budget planning and hiring forecast spreadsheet');
    expect(cosineSimilarity(query, related)).toBeGreaterThan(cosineSimilarity(query, unrelated));
    expect(cosineSimilarity(query, related)).toBeGreaterThan(0.3);
    expect(cosineSimilarity(query, unrelated)).toBeLessThan(0.15);
  });

  it('matches related word forms and tolerates small typos', () => {
    const doc = embedLocally('Restarting the database replica after failover');
    const forms = cosineSimilarity(embedLocally('restart database replica'), doc);
    const typo = cosineSimilarity(embedLocally('restarting the databse replica'), doc);
    const none = cosineSimilarity(embedLocally('invoice payment reminder'), doc);
    expect(forms).toBeGreaterThan(none);
    expect(typo).toBeGreaterThan(none);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors and 0 for zero vectors', () => {
    const v = embedLocally('same text');
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
    expect(cosineSimilarity(v, new Array(EMBEDDING_DIMENSIONS).fill(0))).toBe(0);
  });
});

describe('makeSnippet', () => {
  const content = `${'Intro text. '.repeat(40)}The failover switches traffic to the replica. ${'Outro text. '.repeat(40)}`;

  it('centres on the first matching query term and marks the cut', () => {
    const snippet = makeSnippet(content, 'failover replica');
    expect(snippet).toContain('failover');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(244);
  });

  it('returns short content whole and never contains markup from fences', () => {
    expect(makeSnippet('```bash\nls -la\n```', 'ls')).toBe('ls -la');
  });

  it('falls back to the start when nothing matches', () => {
    expect(makeSnippet(content, 'zzz').startsWith('Intro')).toBe(true);
  });
});

describe('embeddingInput', () => {
  it('puts the heading before the text', () => {
    expect(embeddingInput({ heading: 'A › B', content: 'text' })).toBe('A › B\ntext');
  });
});
