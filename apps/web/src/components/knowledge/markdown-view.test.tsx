import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Highlight, MarkdownView } from './markdown-view';

describe('MarkdownView', () => {
  it('says so when the document is empty', () => {
    render(<MarkdownView source="   " />);
    expect(screen.getByText('This document is empty.')).toBeInTheDocument();
  });

  it('starts headings at h2, because the page title is the h1', () => {
    render(<MarkdownView source={'# Runbook\n\n## Steps\n\n###### Deep'} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Runbook' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Steps' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('renders lists, quotes, rules, inline code and emphasis', () => {
    const { container } = render(
      <MarkdownView
        source={[
          '- one',
          '- two',
          '',
          '1. first',
          '2. second',
          '',
          '> careful',
          '',
          '---',
          '',
          'Use `kubectl` with **care** and *thought*.',
        ].join('\n')}
      />,
    );
    expect(screen.getAllByRole('list')).toHaveLength(2);
    expect(container.querySelector('ol')).toBeInTheDocument();
    expect(container.querySelector('ul')).toBeInTheDocument();
    expect(container.querySelector('blockquote')).toHaveTextContent('careful');
    expect(container.querySelector('hr')).toBeInTheDocument();
    expect(container.querySelector('code')).toHaveTextContent('kubectl');
    expect(container.querySelector('strong')).toHaveTextContent('care');
    expect(container.querySelector('em')).toHaveTextContent('thought');
  });

  it('shows code blocks verbatim and keyboard-scrollable', () => {
    const { container } = render(
      <MarkdownView source={'```\nrm -rf /tmp/x <b>not bold</b>\n```'} />,
    );
    const pre = container.querySelector('pre');
    expect(pre).toHaveAttribute('tabindex', '0');
    expect(pre).toHaveTextContent('rm -rf /tmp/x <b>not bold</b>');
    expect(container.querySelector('pre b')).toBeNull();
  });

  describe('safety', () => {
    it('never turns HTML in a document into elements', () => {
      const { container } = render(
        <MarkdownView
          source={'<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<b>bold</b>'}
        />,
      );
      expect(container.querySelector('script')).toBeNull();
      expect(container.querySelector('img')).toBeNull();
      expect(container.querySelector('b')).toBeNull();
      expect(container).toHaveTextContent('<script>alert(1)</script>');
    });

    it('links only to http(s) and mailto, and opens them without leaking the opener', () => {
      const { container } = render(
        <MarkdownView
          source={[
            '[good](https://example.com/a)',
            '[mail](mailto:ops@example.com)',
            '[bad](javascript:alert(1))',
            '[worse](data:text/html;base64,PHNjcmlwdD4=)',
          ].join('\n\n')}
        />,
      );
      const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
      expect(hrefs).toEqual(['https://example.com/a', 'mailto:ops@example.com']);
      for (const a of container.querySelectorAll('a')) {
        expect(a).toHaveAttribute('target', '_blank');
        expect(a.getAttribute('rel')).toMatch(/noopener/);
        expect(a.getAttribute('rel')).toMatch(/noreferrer/);
      }
      // The unsafe links are shown as plain text, not dropped silently.
      expect(container).toHaveTextContent('bad');
      expect(container).toHaveTextContent('worse');
    });
  });
});

describe('Highlight', () => {
  it('marks the searched words and leaves the rest alone', () => {
    const { container } = render(<Highlight text="Restart the API server" query="api restart" />);
    const marks = Array.from(container.querySelectorAll('mark')).map((m) => m.textContent);
    expect(marks).toEqual(expect.arrayContaining(['Restart', 'API']));
    expect(container).toHaveTextContent('Restart the API server');
  });

  it('marks nothing for an empty query', () => {
    const { container } = render(<Highlight text="Restart the API server" query="" />);
    expect(container.querySelector('mark')).toBeNull();
    expect(container).toHaveTextContent('Restart the API server');
  });

  it('treats regex characters in the query as plain text', () => {
    const { container } = render(<Highlight text="cost is (a+b) today" query="(a+b" />);
    expect(container).toHaveTextContent('cost is (a+b) today');
  });
});
