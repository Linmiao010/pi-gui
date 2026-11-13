import { useEffect, useRef, useState } from "react";
import { CopyIcon } from "../../ui/icons";

const FEEDBACK_MS = 1500;

export function CopyButton({
  text,
  label,
  testId,
  className = "",
}: {
  readonly text: string;
  readonly label: string;
  readonly testId: string;
  readonly className?: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const request = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      request.current += 1;
      clearTimeout(timer.current);
    },
    [],
  );

  const copy = () => {
    const current = ++request.current;
    clearTimeout(timer.current);
    setStatus("idle");
    const finish = (result: "copied" | "failed") => {
      // A virtualized row may have unmounted, or another copy may have finished first.
      if (current !== request.current) return;
      setStatus(result);
      timer.current = setTimeout(() => setStatus("idle"), FEEDBACK_MS);
    };
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(
        () => finish("copied"),
        () => finish("failed"),
      );
  };

  return (
    <button
      type="button"
      className={`timeline-item__action ${className}`.trim()}
      aria-label={label}
      title={label}
      data-testid={testId}
      data-copy-state={status}
      onClick={copy}
      onMouseDown={(event) => event.preventDefault()}
    >
      <CopyIcon />
      <span className="timeline-item__action-label" aria-live="polite">
        {status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : "Copy"}
      </span>
    </button>
  );
}
