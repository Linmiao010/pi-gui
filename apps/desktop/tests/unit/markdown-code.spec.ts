import { expect, test } from "@playwright/test";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Code, RootContent } from "mdast";
import { remarkCodeBlocks } from "../../src/features/conversation/markdown-code";

function codeBlock(markdown: string): Code {
  const processor = unified().use(remarkParse).use(remarkCodeBlocks);
  const tree = processor.parse(markdown);
  processor.runSync(tree, { value: markdown });
  const find = (nodes: readonly RootContent[]): Code | undefined => {
    for (const node of nodes) {
      if (node.type === "code") return node;
      if ("children" in node) {
        const code = find(node.children);
        if (code) return code;
      }
    }
    return undefined;
  };
  const code = find(tree.children);
  if (!code) throw new Error("Expected a parsed code block");
  return code;
}

const cases = [
  ["closed fence", "```python\nif True:\n    print(1)\n```", "if True:\n    print(1)\n"],
  ["blank final line", "```\nx\n\n```", "x\n\n"],
  ["empty code", "```\n```", ""],
  ["blank code line", "```\n\n```", "\n"],
  ["streaming fence", "```python\nx", "x"],
  ["streaming newline", "```python\nx\n", "x\n"],
  ["CRLF", "```\r\na\r\nb\r\n```", "a\r\nb\r\n"],
  ["blockquote", "> ```\n>   x\n> ```", "  x\n"],
  ["list", "- code:\n\n  ```\n    x\n  ```", "  x\n"],
  ["long tilde fence", "~~~~python\nx\n~~~\n~~~~", "x\n~~~\n"],
] as const;

for (const [name, markdown, expected] of cases) {
  test(`code copy preserves ${name}`, () => {
    expect(codeBlock(markdown).data?.hProperties?.dataCodeCopy).toBe(expected);
  });
}

test("math-labelled fences keep their language without entering the KaTeX renderer", () => {
  const properties = codeBlock("```math\n$E=mc^2$\n```").data?.hProperties;
  expect(properties?.dataCodeLanguage).toBe("math");
  expect(properties?.className).toEqual([]);
  expect(properties?.dataCodeCopy).toBe("$E=mc^2$\n");
});
