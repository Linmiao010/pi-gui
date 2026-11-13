import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { normalizeMathMarkdown } from "../../src/features/conversation/markdown-math";

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

function mathNodes(source: string): MarkdownNode[] {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .parse(normalizeMathMarkdown(source));
  const result: MarkdownNode[] = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "math" || node.type === "inlineMath") result.push(node);
    node.children?.forEach(visit);
  };
  visit(tree);
  return result;
}

function render(source: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, remarkMath],
      rehypePlugins: [rehypeKatex],
      children: normalizeMathMarkdown(source),
    }),
  );
}

test("all four math delimiters reach KaTeX with the original LaTeX", () => {
  const source = String.raw`Inline $E=mc^2$ and \(\frac{a_1}{\sqrt{b}}\).

$$
\sum_{i=1}^n i
$$

\[
\int_0^1 x^2\,dx
\]`;
  expect(mathNodes(source).map(({ type, value }) => ({ type, value }))).toEqual([
    { type: "inlineMath", value: "E=mc^2" },
    { type: "inlineMath", value: String.raw`\frac{a_1}{\sqrt{b}}` },
    { type: "math", value: String.raw`\sum_{i=1}^n i` },
    { type: "math", value: String.raw`\int_0^1 x^2\,dx` },
  ]);
  const html = render(source);
  expect(html.match(/class="katex"/g)).toHaveLength(4);
  expect(html.match(/class="katex-display"/g)).toHaveLength(2);
  expect(html).not.toContain("katex-error");
});

test("multiline environments retain LaTeX row breaks and render without errors", () => {
  for (const formula of [
    String.raw`\begin{aligned}
a &= b + c \\
d &= e
\end{aligned}`,
    String.raw`f(x)=\begin{cases}x^2 & x \ge 0 \\ -x & x < 0\end{cases}`,
    String.raw`\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}`,
  ]) {
    const source = `\\[\n${formula}\n\\]`;
    expect(mathNodes(source).map(({ value }) => value)).toEqual([formula]);
    expect(render(source)).toContain('class="katex-display"');
    expect(render(source)).not.toContain("katex-error");
  }
});

test("same-line display delimiters still create display math", () => {
  for (const source of [String.raw`Before \[x^2\] after`, "Before $$x^2$$ after"]) {
    expect(mathNodes(source).map(({ type, value }) => ({ type, value }))).toEqual([
      { type: "math", value: "x^2" },
    ]);
    const html = render(source);
    expect(html).toContain("Before");
    expect(html).toContain("after");
    expect(html).toContain('class="katex-display"');
  }
});

test("code fences, indented code and different inline backtick lengths stay literal", () => {
  const source = [
    "```python",
    String.raw`formula = r"$E=mc^2$ \(x\) \[y\]"`,
    "```",
    "",
    String.raw`    $indented$ \(code\)`,
    "",
    String.raw`Inline ` + "`$x$ \\(y\\)` and ``one ` $z$ \\[w\\]``.",
  ].join("\n");
  expect(normalizeMathMarkdown(source)).toBe(source);
  expect(mathNodes(source)).toEqual([]);
  expect(render(source)).toContain('class="language-python"');
});

test("escaped dollars and escaped backslashes cannot open math", () => {
  const source = String.raw`Escaped \$x\$ and \\(x\\) and \\[y\\].`;
  expect(normalizeMathMarkdown(source)).toBe(source);
  expect(mathNodes(source)).toEqual([]);
  expect(render(source)).toContain(String.raw`Escaped $x$ and \(x\) and \[y\].`);
  expect(mathNodes(String.raw`\\\(x\)`)).toHaveLength(1);
});

test("ordinary amounts stay text next to actual math", () => {
  const source = "Costs $5 and $10, or $1,200.50 USD; formula $x+1$ and $2+2$ remains.";
  expect(mathNodes(source).map(({ value }) => value)).toEqual(["x+1", "2+2"]);
  const html = render(source);
  expect(html).toContain("Costs $5 and $10, or $1,200.50 USD; formula ");
  expect(html.match(/class="katex"/g)).toHaveLength(2);
});

test("links, destinations, definitions, HTML and GFM tables survive normalization", () => {
  const link = String.raw`[source](https://example.com/$value$/\(raw\) "price $5")`;
  const source = [
    link,
    "",
    String.raw`[reference]: https://example.com/$value$/\(raw\) "title $5"`,
    "",
    String.raw`<span data-formula="\(x\) $y$">raw</span>`,
    "",
    "| Formula | Price |",
    "| --- | --- |",
    String.raw`| \(x^2\) | $5 |`,
  ].join("\n");
  const normalized = normalizeMathMarkdown(source);
  expect(normalized).toContain(link);
  expect(normalized).toContain(
    String.raw`[reference]: https://example.com/$value$/\(raw\) "title $5"`,
  );
  expect(normalized).toContain(String.raw`<span data-formula="\(x\) $y$">raw</span>`);
  expect(mathNodes(source).map(({ value }) => value)).toEqual(["x^2"]);
  expect(render(source)).toContain("<table>");
  expect(render(source)).toContain("<td>$5</td>");
});

test("math never consumes a protected code or link region between delimiters", () => {
  for (const source of ["$before `code` after$", "$before [link](https://example.com) after$"]) {
    expect(mathNodes(source)).toEqual([]);
    expect(render(source)).toContain("$before ");
    expect(render(source)).toContain(" after$");
  }
});

for (const source of [
  "$",
  "$$",
  "$$\n\\int_0^",
  String.raw`\(x_1`,
  "\\[\n\\begin{aligned}\na &= b \\\\",
  "$x_1",
]) {
  test(`streaming math stays visible until its delimiter closes: ${JSON.stringify(source)}`, () => {
    expect(mathNodes(source)).toEqual([]);
    const html = render(source);
    expect(html).not.toContain("katex");
    // Escaping Markdown punctuation is allowed; the user must see the original source.
    const plainText = html
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .trim();
    expect(plainText).toBe(source.trim());
  });
}

test("completed streaming math switches to KaTeX and malformed commands remain non-blocking", () => {
  expect(render("$$\n\\int_0^1 x dx\n$$")).toContain('class="katex-display"');
  const html = render(String.raw`Before $\unknownCommand{x}$ after.`);
  expect(html).toContain("Before");
  expect(html).toContain("after.");
  expect(html).toContain("unknownCommand");
});

test("every incomplete prefix of a multiline formula remains visible", () => {
  const source = String.raw`\[
\begin{aligned}
x_1 &= a \\
x_2 &= b
\end{aligned}
\]`;
  for (let length = 1; length < source.length; length++) {
    const prefix = source.slice(0, length);
    expect(mathNodes(prefix), prefix).toEqual([]);
    const plainText = render(prefix)
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .trim();
    expect(plainText, prefix).toBe(prefix.trim());
  }
  expect(mathNodes(source)).toHaveLength(1);
});

test("an unfinished inline formula cannot suppress a later paragraph's valid formula", () => {
  const source = "$unfinished_1\n\nNext paragraph has $x^2$.";
  expect(mathNodes(source).map(({ value }) => value)).toEqual(["x^2"]);
  expect(render(source)).toContain("$unfinished_1");
});

test("formulas in link labels leave the destination unchanged", () => {
  const source = String.raw`[\(x^2\)](https://example.com/$value$)`;
  expect(mathNodes(source).map(({ value }) => value)).toEqual(["x^2"]);
  expect(render(source)).toContain('href="https://example.com/$value$"');
});

test("display math in block quotes keeps the quote and TeX source intact", () => {
  const source = "> \\[\n> x^2\n> \\]";
  const html = render(source);
  expect(html).toContain("<blockquote>");
  expect(html).toContain('class="katex-display"');
  expect(html).not.toContain("katex-error");
  expect(mathNodes(source).map(({ value }) => value)).toEqual(["x^2"]);
});

test("display delimiters stay inline inside table cells and link labels", () => {
  const source = [
    "| First | Second |",
    "| --- | --- |",
    String.raw`| \[x^2\] | $$y^2$$ and ` + "`$code$` |",
    "",
    String.raw`[\[z^2\]](https://example.com/$value$)`,
  ].join("\n");
  const html = render(source);
  expect(html).toContain("<table>");
  expect(html.match(/<td>/g)).toHaveLength(2);
  expect(html).toContain("<code>$code$</code>");
  expect(html).toContain('href="https://example.com/$value$"');
  expect(html.match(/class="katex"/g)).toHaveLength(3);
  const table = html.match(/<table>[\s\S]*?<\/table>/)?.[0] ?? "";
  const link = html.match(/<a href="https:\/\/example.com\/\$value\$">[\s\S]*?<\/a>/)?.[0] ?? "";
  expect(table.match(/class="katex"/g) ?? []).toHaveLength(2);
  expect(link.match(/class="katex"/g) ?? []).toHaveLength(1);
  expect(mathNodes(source).map(({ value }) => value)).toEqual(["x^2", "y^2", "z^2"]);
});

test("same-line display math remains inside its blockquote or list item", () => {
  for (const { source, container } of [
    { source: "> $$x^2$$", container: "blockquote" },
    { source: "- $$x^2$$", container: "li" },
    { source: String.raw`> Before \[x^2\] after`, container: "blockquote" },
    { source: String.raw`- Before \[x^2\] after`, container: "li" },
    { source: "- First line\n  Before \\[x^2\\] after", container: "li" },
  ]) {
    const html = render(source);
    const contents = html.match(new RegExp(`<${container}>[\\s\\S]*?</${container}>`))?.[0] ?? "";
    expect(contents.match(/class="katex"/g) ?? [], source).toHaveLength(1);
    if (source.includes("after")) expect(contents, source).toContain("after");
    expect(mathNodes(source).map(({ value }) => value)).toEqual(["x^2"]);
  }
});
