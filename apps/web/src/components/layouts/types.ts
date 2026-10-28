import { withoutCitations, withoutColors, type LayoutSpec, type ListItem, type PageBlock } from '@nicotes/shared';

export type ListBlock = Extract<PageBlock, { kind: 'list' }>;
export const isList = (b: PageBlock): b is ListBlock => b.kind === 'list';

/** What every layout view gets: the page text, its blocks and the spec, and a way to edit. */
export interface LayoutProps {
  pageId: string;
  notebookId: string;
  title: string;
  markdown: string;
  blocks: PageBlock[];
  spec: LayoutSpec;
  /** Replaces the page text (saved like editor changes, undoable in the view). */
  onChange: (markdown: string) => void;
  /** Leave source citations out of the text shown (the page keeps them). */
  hideSources?: boolean;
}

/** Item text without Markdown syntax, for labels and speech. */
export const plainText = (text: string) =>
  withoutColors(text)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
    .trim();

/**
 * Steps from step blocks: each top-level list item (with its nested items) or paragraph is one
 * step. Citation links (pages written by Research) are left out.
 */
export function stepsFrom(blocks: PageBlock[]): { key: string; text: string; details: string[] }[] {
  return blocks.flatMap((block) => {
    if (block.kind === 'list') {
      const steps: { key: string; text: string; details: string[] }[] = [];
      block.items.forEach((item: ListItem, n) => {
        const text = withoutCitations(item.text);
        if (item.depth === 0 || !steps.length) steps.push({ key: `${block.key}:${n}`, text, details: [] });
        else steps.at(-1)!.details.push(text);
      });
      return steps;
    }
    if (block.kind === 'paragraph' || block.kind === 'quote') return [{ key: block.key, text: withoutCitations(block.text), details: [] }];
    return [];
  });
}
