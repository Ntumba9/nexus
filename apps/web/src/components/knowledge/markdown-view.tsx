import type { ReactNode } from 'react';
import { parseMarkdown, splitHighlight, type Block, type Inline } from '@/lib/markdown';

/**
 * Renders a document. It builds React elements from parsed data, so text is always escaped and
 * nothing in a document can become markup or script; links only ever point at http(s) or mailto.
 */
export function MarkdownView({ source }: { source: string }) {
  const blocks = parseMarkdown(source);
  if (blocks.length === 0) return <p className="text-sm text-muted">This document is empty.</p>;
  return <div className="space-y-4 text-sm leading-7">{blocks.map(renderBlock)}</div>;
}

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.t) {
      case 'text':
        return node.text;
      case 'code':
        return (
          <code key={i} className="rounded bg-white/10 px-1 py-0.5 font-mono text-[0.85em]">
            {node.text}
          </code>
        );
      case 'strong':
        return <strong key={i}>{renderInline(node.children)}</strong>;
      case 'em':
        return <em key={i}>{renderInline(node.children)}</em>;
      case 'link':
        return (
          <a
            key={i}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-accent underline underline-offset-2"
          >
            {renderInline(node.children)}
          </a>
        );
    }
  });
}

const HEADING_CLASS = {
  1: 'text-xl font-semibold tracking-tight',
  2: 'text-lg font-semibold tracking-tight',
  3: 'text-base font-semibold',
  4: 'text-sm font-semibold',
  5: 'text-sm font-semibold text-muted',
  6: 'text-sm font-medium text-muted',
} as const;

function renderBlock(block: Block, i: number): ReactNode {
  switch (block.t) {
    case 'heading': {
      const Tag = `h${Math.min(6, block.level + 1)}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      // The page title is the h1, so document headings start at h2 for a correct outline.
      return (
        <Tag key={i} className={`${HEADING_CLASS[block.level]} pt-2`}>
          {renderInline(block.children)}
        </Tag>
      );
    }
    case 'paragraph':
      return <p key={i}>{renderInline(block.children)}</p>;
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag key={i} className={`space-y-1 pl-6 ${block.ordered ? 'list-decimal' : 'list-disc'}`}>
          {block.items.map((item, j) => (
            <li key={j}>{renderInline(item)}</li>
          ))}
        </Tag>
      );
    }
    case 'code':
      return (
        <pre
          key={i}
          tabIndex={0}
          className="overflow-x-auto rounded-lg border border-border bg-black/30 p-3 font-mono text-xs leading-6"
        >
          <code>{block.text}</code>
        </pre>
      );
    case 'quote':
      return (
        <blockquote key={i} className="border-l-2 border-accent/50 pl-4 text-muted">
          {renderInline(block.children)}
        </blockquote>
      );
    case 'rule':
      return <hr key={i} className="border-border" />;
  }
}

/** Text with the words of a search query highlighted. */
export function Highlight({ text, query }: { text: string; query: string }) {
  return (
    <>
      {splitHighlight(text, query).map((part, i) =>
        part.match ? (
          <mark key={i} className="rounded bg-accent/25 px-0.5 text-foreground">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}
