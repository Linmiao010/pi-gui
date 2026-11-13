/**
 * Offsets count content text, excluding controls inside the Markdown (such as code headers).
 * This keeps anchors stable when Copy becomes Copied or a virtualized row remounts.
 */
export const ANNOTATION_IGNORED_SELECTOR = "[data-annotation-ignore]";

function* contentTextNodes(root: Node): Generator<Node> {
  const visible = (node: Node) => !node.parentElement?.closest(ANNOTATION_IGNORED_SELECTOR);
  if (root.nodeType === Node.TEXT_NODE) {
    if (visible(root)) yield root;
    return;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (visible(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) yield node;
}

export function annotationText(root: Node): string {
  let text = "";
  for (const node of contentTextNodes(root)) text += node.nodeValue ?? "";
  return text;
}

export function annotationRangeText(range: Range): string {
  let text = "";
  for (const node of contentTextNodes(range.commonAncestorContainer)) {
    if (!range.intersectsNode(node)) continue;
    const value = node.nodeValue ?? "";
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : value.length;
    text += value.slice(start, end);
  }
  return text;
}

export function rangeToOffsets(
  root: Node,
  range: Range,
): { readonly start: number; readonly end: number } {
  const before = document.createRange();
  before.setStart(root, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const start = annotationRangeText(before).length;
  return { start, end: start + annotationRangeText(range).length };
}

export function offsetsToRange(root: Node, start: number, end: number): Range | null {
  if (end <= start) return null;
  const range = document.createRange();
  let seen = 0;
  let started = false;
  for (const node of contentTextNodes(root)) {
    const length = node.nodeValue?.length ?? 0;
    if (!started && start < seen + length) {
      range.setStart(node, start - seen);
      started = true;
    }
    if (started && end <= seen + length) {
      range.setEnd(node, end - seen);
      return range;
    }
    seen += length;
  }
  return null;
}
