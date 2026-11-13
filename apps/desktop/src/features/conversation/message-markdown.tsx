import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { CopyButton } from "./copy-button";
import { normalizeMathMarkdown } from "./markdown-math";
import { remarkCodeBlocks } from "./markdown-code";
import {
  remarkWorkspaceFileLines,
  workspaceFileLineFromAnchorProps,
  type WorkspaceFileLine,
} from "./workspace-file-line";

const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkCodeBlocks];
const REHYPE_PLUGINS = [rehypeKatex];

function markdownComponents(
  onOpenWorkspaceFileLine?: (target: WorkspaceFileLine) => void,
): Components {
  return {
    code: ({ className, children, node }) => {
      const code = String(children).replace(/\n$/, "");
      const language = node?.properties.dataCodeLanguage;
      return <code className={language === "math" ? "language-math" : className}>{code}</code>;
    },
    pre: ({ children, node }) => {
      const code = node?.children.find(
        (child) => child.type === "element" && child.tagName === "code",
      );
      if (code?.type !== "element" || typeof code.properties.dataCodeCopy !== "string") {
        return <pre>{children}</pre>;
      }
      const language = code.properties.dataCodeLanguage;
      return (
        <div className="message__code-block">
          <div className="message__code-header" data-annotation-ignore="">
            <span>{typeof language === "string" ? language : ""}</span>
            <CopyButton text={code.properties.dataCodeCopy} label="Copy code" testId="copy-code" />
          </div>
          <pre>{children}</pre>
        </div>
      );
    },
    a: ({ href, children, ...props }) => {
      const file = onOpenWorkspaceFileLine ? workspaceFileLineFromAnchorProps(props) : null;
      if (file && onOpenWorkspaceFileLine) {
        return (
          <button
            className="message__file-link"
            data-end-line={file.endLine}
            data-line={file.line}
            data-path={file.path}
            data-testid="workspace-file-link"
            type="button"
            onClick={() => onOpenWorkspaceFileLine(file)}
          >
            {children}
          </button>
        );
      }
      return (
        <a href={href} rel="noreferrer" target="_blank">
          {children}
        </a>
      );
    },
    table: ({ children }) => (
      <div className="message__table-scroll">
        <table>{children}</table>
      </div>
    ),
  };
}

const PLAIN_MARKDOWN_COMPONENTS = markdownComponents();

// Memoized: remark parsing is the dominant render cost on long threads, and the
// timeline re-renders on every streaming tick. `text` is a string, so shallow
// comparison skips the re-parse for every message except the one still growing.
export const MessageMarkdown = memo(function MessageMarkdown({
  text,
  workspacePath,
  onOpenWorkspaceFileLine,
  annotationRoot = false,
}: {
  readonly text: string;
  /** Marks this text as what transcript annotations anchor to. */
  readonly annotationRoot?: boolean;
  readonly workspacePath?: string;
  readonly onOpenWorkspaceFileLine?: (target: WorkspaceFileLine) => void;
}) {
  const markdown = useMemo(() => normalizeMathMarkdown(text), [text]);
  const components = useMemo(
    () =>
      onOpenWorkspaceFileLine
        ? markdownComponents(onOpenWorkspaceFileLine)
        : PLAIN_MARKDOWN_COMPONENTS,
    [onOpenWorkspaceFileLine],
  );
  const remarkPlugins = useMemo(
    () =>
      onOpenWorkspaceFileLine
        ? [...REMARK_PLUGINS, remarkWorkspaceFileLines(workspacePath ?? null)]
        : REMARK_PLUGINS,
    [onOpenWorkspaceFileLine, workspacePath],
  );
  return (
    <div className="message__content" data-annotation-root={annotationRoot ? "" : undefined}>
      <ReactMarkdown
        components={components}
        remarkPlugins={remarkPlugins}
        rehypePlugins={REHYPE_PLUGINS}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
});
