import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

interface MarkdownNode {
  type: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

interface SourceRange {
  start: number;
  end: number;
  mode: "literal" | "inline" | "container";
}

const markdownParser = unified().use(remarkParse).use(remarkGfm);
const literalNodes = new Set([
  "code",
  "inlineCode",
  "html",
  "definition",
  "image",
  "imageReference",
]);

function sourceRanges(text: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  const visit = (node: MarkdownNode) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      if (literalNodes.has(node.type)) {
        ranges.push({ start, end, mode: "literal" });
        return;
      }
      if (node.type === "tableCell") ranges.push({ start, end, mode: "inline" });
      if (node.type === "blockquote" || node.type === "listItem") {
        ranges.push({ start, end, mode: "container" });
      }
      if (node.type === "link" || node.type === "linkReference") {
        const labelStart = node.children?.[0]?.position?.start.offset;
        const labelEnd = node.children?.at(-1)?.position?.end.offset;
        // Autolinks have no separate label; normal links may contain inline math.
        if (text[start] !== "[" || labelStart === undefined || labelEnd === undefined) {
          ranges.push({ start, end, mode: "literal" });
          return;
        }
        ranges.push(
          { start, end: labelStart, mode: "literal" },
          { start: labelStart, end: labelEnd, mode: "inline" },
          { start: labelEnd, end, mode: "literal" },
        );
      }
    }
    node.children?.forEach(visit);
  };
  visit(markdownParser.parse(text));
  return ranges;
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  while (index > 0 && text[--index] === "\\") slashes++;
  return slashes % 2 === 1;
}

function escapeLiteral(text: string): string {
  return text.replace(/[\\`*{}[\]()#+\-.!_>$|]/g, "\\$&");
}

function closingDelimiter(text: string, start: number, delimiter: string): number {
  for (let index = start; index < text.length; index++) {
    if (delimiter === "$" && (text[index] === "\n" || text[index] === "\r")) return -1;
    if (!text.startsWith(delimiter, index) || isEscaped(text, index)) continue;
    if (
      delimiter[0] === "$" &&
      (text[index - 1] === "$" || text[index + delimiter.length] === "$")
    ) {
      continue;
    }
    return index;
  }
  return -1;
}

function displayMath(
  text: string,
  start: number,
  end: number,
  body: string,
  inContainer: boolean,
): string {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = text.indexOf("\n", end);
  const before = text.slice(lineStart, start);
  const after = text.slice(end, lineEnd < 0 ? text.length : lineEnd);
  if (
    /^[\t ]*(?:>[\t ]*)*(?:(?:[-+*]|\d+[.)])[\t ]+)?$/.test(before) &&
    /^[\t ]*$/.test(after) &&
    /^\r?\n/.test(body)
  ) {
    return `$$${body}$$`;
  }
  // Inserting root-level blank lines would move same-line math and following
  // prose out of a quote/list. Keep these formulas within their current item.
  if (inContainer) return `$${body}$`;
  return `\n\n$$\n${body.replace(/^\r?\n|\r?\n$/g, "")}\n$$\n\n`;
}

function normalizeText(text: string, inlineOnly: boolean, inContainer: boolean): string {
  let result = "";
  for (let index = 0; index < text.length;) {
    const texDelimiter = text[index] === "\\" && !isEscaped(text, index);
    const opening = texDelimiter && (text[index + 1] === "(" || text[index + 1] === "[");
    const dollar = text[index] === "$" && !isEscaped(text, index);
    if (!opening && !dollar) {
      result += text[index++];
      continue;
    }

    const display = opening ? text[index + 1] === "[" : text[index + 1] === "$";
    const width = opening || display ? 2 : 1;
    const closing = opening ? (display ? "\\]" : "\\)") : display ? "$$" : "$";
    const end = closingDelimiter(text, index + width, closing);
    const body = end < 0 ? "" : text.slice(index + width, end);
    const inlineDollar = dollar && !display;
    const valid =
      end >= 0 &&
      body.trim().length > 0 &&
      (!inlineDollar || (!/^\s|\s$/.test(body) && !/\d/.test(text[end + 1] ?? "")));

    if (valid) {
      result +=
        display && !inlineOnly
          ? displayMath(text, index, end + width, body, inContainer)
          : `$${body}$`;
      index = end + width;
    } else if (opening || display || (end < 0 && !/[\d\s]/.test(text[index + 1] ?? " "))) {
      // remark-math accepts an unfinished display fence. Escape its contents as
      // literal Markdown until the next streaming update supplies the closer.
      const lineEnd = display ? -1 : text.indexOf("\n", index);
      const literalEnd = lineEnd < 0 ? text.length : lineEnd;
      result += escapeLiteral(text.slice(index, literalEnd));
      index = literalEnd;
    } else {
      // Unpaired currency and whitespace-delimited dollars must not be paired
      // by remark-math with a later, unrelated formula.
      result += "\\$";
      index++;
    }
  }
  return result;
}

/** Normalize rendering input only. Message copy continues to use the original Markdown. */
export function normalizeMathMarkdown(text: string): string {
  if (!text.includes("$") && !text.includes("\\(") && !text.includes("\\[")) return text;
  // Table cells and link labels accept only phrasing content. Sweep their
  // boundaries together with literal regions so nested code remains untouched.
  const boundaries = new Map<number, { literal: number; inline: number; container: number }>();
  for (const { start, end, mode } of sourceRanges(text)) {
    for (const [offset, delta] of [
      [start, 1],
      [end, -1],
    ] as const) {
      const boundary = boundaries.get(offset) ?? { literal: 0, inline: 0, container: 0 };
      boundary[mode] += delta;
      boundaries.set(offset, boundary);
    }
  }
  let result = "";
  let cursor = 0;
  let literal = 0;
  let inline = 0;
  let container = 0;
  for (const [offset, delta] of [...boundaries].sort(([a], [b]) => a - b)) {
    const source = text.slice(cursor, offset);
    result += literal > 0 ? source : normalizeText(source, inline > 0, container > 0);
    literal += delta.literal;
    inline += delta.inline;
    container += delta.container;
    cursor = offset;
  }
  return result + normalizeText(text.slice(cursor), false, false);
}
