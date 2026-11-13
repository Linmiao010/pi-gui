import type { Code, Root, RootContent } from "mdast";
import type { VFile } from "vfile";

// Keep copy data on the parsed code node, before the HTML renderer adds its own newline.
// No text is read back from the DOM (which may contain labels or highlighting spans).
export function remarkCodeBlocks() {
  return (tree: Root, file: VFile) => {
    const source = String(file.value);
    const visit = (nodes: readonly RootContent[]) => {
      for (const node of nodes) {
        if (node.type === "code") {
          const raw = source.slice(node.position?.start.offset, node.position?.end.offset);
          node.data = {
            ...node.data,
            hProperties: {
              ...node.data?.hProperties,
              dataCodeCopy: codeCopyText(node, raw),
              dataCodeLanguage: node.lang?.split(/\s+/)[0] ?? "",
              // rehype-katex also renders language-math fences by default. Fences are
              // source examples here; the code component restores this class afterward.
              ...(node.lang?.split(/\s+/)[0] === "math" ? { className: [] } : {}),
            },
          };
        } else if ("children" in node) {
          visit(node.children);
        }
      }
    };
    visit(tree.children);
  };
}

function codeCopyText(node: Code, source: string): string {
  const lines = source.split(/(\r\n|\n|\r)/);
  const opening = /^[ \t]*(`{3,}|~{3,})/.exec(lines[0] ?? "")?.[1];
  if (!opening) return node.value;
  const last = lines.at(-1) ?? "";
  const closing = /^(?:[ \t]*>[ \t]?)*[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(last)?.[1];
  const closed =
    closing !== undefined && closing[0] === opening[0] && closing.length >= opening.length;
  // A closed fence's separator is part of the code. For an open streaming fence,
  // append it only if it has actually arrived. An empty block has no code line.
  const ending = lines.length > 3 && (closed || last === "") ? (lines.at(-2) ?? "") : "";
  return node.value + ending;
}
