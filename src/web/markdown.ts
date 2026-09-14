// What an ask-AI answer may carry besides Markdown: a line break written as `<br>`, and
// nothing else.

/** The part of a Markdown syntax tree the walk below reads. */
interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

const BR = /^<\/?br\s*\/?>$/i;

/**
 * A remark plugin that turns every `<br>` into a line break. A table cell cannot hold a
 * newline, so a model breaking a line inside one writes `<br>`, and react-markdown shows
 * raw HTML as the text it was written in. That is right for every other tag — the answer
 * is a model's, not ours to trust — so this one tag becomes the break it means before the
 * tree is rendered, and no HTML is ever rendered as HTML. A `<br>` inside code stays text,
 * because code is not an `html` node.
 */
export function htmlBreaks() {
  return function walk(node: MarkdownNode): void {
    node.children?.forEach((child, index, siblings) => {
      if (child.type === "html" && BR.test(child.value ?? ""))
        siblings[index] = { type: "break" };
      else walk(child);
    });
  };
}
