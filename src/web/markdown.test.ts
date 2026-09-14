import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { htmlBreaks } from "./markdown.ts";

/** The ask-AI popup's own rendering, to a string. */
const render = (markdown: string) =>
  renderToStaticMarkup(
    createElement(Markdown, { remarkPlugins: [remarkGfm, htmlBreaks] }, markdown),
  );

test("a <br> in a table cell breaks the line, in each of the ways models write it", () => {
  const html = render(
    "| 词 | 说明 |\n| --- | --- |\n| 仮釈放 | かりしゃくほう<br>parole<BR />假释 |",
  );
  assert.match(html, /<td>かりしゃくほう<br\/>\s*parole<br\/>\s*假释<\/td>/);
});

test("every other tag is still shown as the text it was written in", () => {
  const html = render("a <script>alert(1)</script> and `<br>` in code");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<code>&lt;br&gt;<\/code>/);
});
