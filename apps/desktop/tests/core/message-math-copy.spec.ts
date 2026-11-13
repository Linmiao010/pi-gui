import { expect, test, type Locator, type Page } from "@playwright/test";
import { formatAnnotatedPrompt } from "../../src/features/conversation/annotations/annotation-prompt";
import {
  createNamedThread,
  desktopShortcut,
  emitTestSessionEvent,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForTimelineLayout,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";
import { appendMessagesToSessionFile, sessionFilePathFromCatalog } from "../helpers/session-file";

// Saved transcripts and injected events exercise the real renderer without a provider.
// Clipboard writes are isolated to this page; these tests do not prove native OS clipboard access.
async function launchWithTranscript(
  name: string,
  messages: Parameters<typeof appendMessagesToSessionFile>[1],
) {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace(name);
  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  let workspaceId = "";
  let sessionId = "";
  try {
    const page = await firstRun.firstWindow();
    await waitForWorkspaceByPath(page, workspacePath);
    await createNamedThread(page, name);
    const state = await getDesktopState(page);
    workspaceId = state.selectedWorkspaceId;
    sessionId = state.selectedSessionId;
  } finally {
    await firstRun.close();
  }
  const sessionFile = await sessionFilePathFromCatalog(userDataDir, { workspaceId, sessionId });
  await appendMessagesToSessionFile(sessionFile, messages);
  return launchDesktop(userDataDir, { testMode: "background" });
}

async function stubClipboard(page: Page, failNext = false): Promise<void> {
  await page.evaluate((shouldFail) => {
    const state = { writes: [] as string[], failNext: shouldFail };
    (globalThis as { __mathCopyClipboard?: typeof state }).__mathCopyClipboard = state;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          if (state.failNext) {
            state.failNext = false;
            return Promise.reject(
              new DOMException("Fixture clipboard rejection", "NotAllowedError"),
            );
          }
          state.writes.push(text);
          return Promise.resolve();
        },
      },
    });
  }, failNext);
}

async function clipboardWrites(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (globalThis as { __mathCopyClipboard?: { writes: string[] } }).__mathCopyClipboard?.writes ??
      [],
  );
}

async function tabTo(page: Page, target: Locator): Promise<void> {
  // Tab through real controls, without programmatically focusing the target or hovering it.
  for (let index = 0; index < 80; index += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error("Copy control was not reachable with Tab");
}

async function expectVisibleKeyboardFocus(button: Locator): Promise<void> {
  await expect(button).toBeFocused();
  await button.evaluate(async (element) => {
    const transitions: Animation[] = [];
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      transitions.push(...ancestor.getAnimations());
    }
    // Focus reveals the action bar with a CSS transition. Await that transition's
    // completion instead of sampling opacity at its initial zero value.
    await Promise.all(transitions.map((transition) => transition.finished));
  });
  expect(
    await button.evaluate((element) => {
      const style = getComputedStyle(element);
      let ancestorsVisible = true;
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        if (Number(getComputedStyle(ancestor).opacity) !== 1) ancestorsVisible = false;
      }
      return {
        focused: element === document.activeElement && element.matches(":focus-visible"),
        ancestorsVisible,
        focusRingVisible:
          (style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0) ||
          style.boxShadow !== "none",
      };
    }),
  ).toEqual({ focused: true, ancestorsVisible: true, focusRingVisible: true });
}

const pythonCode = 'def formula():\n    return r"$E=mc^2$ and \\(x\\)"\n\n';
const unlabelledCode = "first line\n\tindented line\n";
const assistantMarkdown = [
  "## Copy source proof",
  "",
  "Select this phrase beside $E=mc^2$ and **keep the Markdown**.",
  "",
  "| Kind | Source |",
  "| --- | --- |",
  "| math | \\(x^2\\) |",
  "",
  "```python",
  `${pythonCode}\`\`\``,
  "",
  "```",
  `${unlabelledCode}\`\`\``,
].join("\n");

test("renders all math delimiters and environments without changing code or overflowing the transcript", async () => {
  const mathMarkdown = [
    "Math rendering proof: $E=mc^2$ and \\(\\alpha_i=\\sqrt{x_i}\\).",
    "",
    String.raw`$$
\begin{aligned}
\int_0^1 x^2\,dx &= \frac{1}{3} \\
\sum_{n=1}^{\infty}\frac{1}{n^2} &= \frac{\pi^2}{6}
\end{aligned}
$$`,
    "",
    String.raw`\[
f(x)=\begin{cases}x^2 & x\geq0 \\ -x & x<0\end{cases}
\]`,
    "",
    String.raw`$$\det\begin{pmatrix}1&2\\3&4\end{pmatrix}=-2$$`,
    "",
    `$$${Array.from({ length: 60 }, (_, index) => `x_{${index}}`).join("+")}$$`,
    "",
    "Code stays literal: `$inline$` and `\\(inline\\)`; escaped \\$5, prices $10 and $20.",
    "",
    "```math",
    String.raw`\(code\) + $code$ + \[code\]`,
    "```",
    "",
    "[Documentation](https://example.com/math) and **ordinary Markdown**.",
    "",
    "| Value | Meaning |",
    "| --- | --- |",
    "| 1 | unchanged |",
  ].join("\n");
  const harness = await launchWithTranscript("message-math-rendering", [
    { role: "user", text: "User math: $E=mc^2$ and \\(x_i^2\\)." },
    { role: "assistant", text: mathMarkdown },
  ]);
  try {
    const page = await harness.firstWindow();
    const user = page.locator(".timeline-item--user");
    const assistant = page.locator(".timeline-item--assistant");
    await expect(user.locator(".katex")).toHaveCount(2);
    await expect(assistant.locator(".katex")).toHaveCount(6);
    await expect(assistant.locator(".katex-display")).toHaveCount(4);
    await expect(assistant.locator(".katex-error")).toHaveCount(0);
    await expect(assistant.locator("pre code")).toHaveText(
      String.raw`\(code\) + $code$ + \[code\]`,
    );
    await expect(assistant.locator("pre .katex")).toHaveCount(0);
    await expect(assistant.locator(":not(pre) > code")).toHaveText([
      "$inline$",
      String.raw`\(inline\)`,
    ]);
    await expect(assistant).toContainText("escaped $5, prices $10 and $20.");
    await expect(assistant.getByRole("link", { name: "Documentation" })).toHaveAttribute(
      "href",
      "https://example.com/math",
    );
    await expect(assistant.locator("table tbody tr")).toHaveText("1unchanged");

    for (const theme of [/^(Light|浅色)$/, /^(Dark|深色)$/]) {
      await page.keyboard.press(desktopShortcut(","));
      await expect(page.getByTestId("settings-surface")).toBeVisible();
      await page.getByRole("button", { name: /^(Appearance|外观)$/ }).click();
      await page.getByRole("radio", { name: theme }).click();
      await page.getByRole("button", { name: /^(Back to app|返回应用)$/ }).click();
      await waitForTimelineLayout(page);
      await expect(assistant.locator(".katex-html").first()).toBeVisible();
      expect(
        await assistant
          .locator(".katex")
          .first()
          .evaluate((element) => {
            const content = element.closest(".message__content");
            return content && getComputedStyle(element).color === getComputedStyle(content).color;
          }),
      ).toBe(true);
      const longFormula = assistant.locator(".katex-display").last();
      await expect
        .poll(() =>
          longFormula.evaluate((element) => {
            const transcript = document.querySelector<HTMLElement>('[data-testid="transcript"]');
            if (!transcript) throw new Error("Missing transcript");
            return {
              localOverflow: element.scrollWidth > element.clientWidth + 1,
              scrollable: ["auto", "scroll"].includes(getComputedStyle(element).overflowX),
              transcriptFits: transcript.scrollWidth <= transcript.clientWidth + 1,
            };
          }),
        )
        .toEqual({ localOverflow: true, scrollable: true, transcriptFits: true });
      expect(
        await longFormula.evaluate((element) => {
          element.scrollLeft = 80;
          return element.scrollLeft;
        }),
      ).toBeGreaterThan(0);
    }
  } finally {
    await harness.close();
  }
});

test("copies original message Markdown and exact code whitespace with honest temporary feedback", async () => {
  const userMarkdown = formatAnnotatedPrompt(
    [{ quote: "An earlier formula", note: "Keep its source" }],
    "User **Markdown** with \\(x^2\\).\n\nA second paragraph.",
  );
  const harness = await launchWithTranscript("message-math-copy-source", [
    { role: "user", text: userMarkdown },
    { role: "assistant", text: assistantMarkdown },
  ]);
  try {
    const page = await harness.firstWindow();
    const user = page.locator(".timeline-item--user");
    const assistant = page.locator(".timeline-item--assistant");
    const userCopy = user.getByTestId("copy-message");
    const assistantCopy = assistant.getByTestId("copy-message");
    await expect(userCopy).toHaveCount(1);
    await expect(assistantCopy).toHaveCount(1);
    await expect(userCopy).toHaveAttribute("aria-label", "Copy user message");
    await expect(assistantCopy).toHaveAttribute("aria-label", "Copy assistant message");
    await expect(userCopy).toHaveAttribute("type", "button");
    await expect(assistantCopy).toHaveAttribute("type", "button");
    await expect(user.getByTestId("sent-annotation")).toBeVisible();
    await expect(user).not.toContainText("<annotation>");
    await waitForTimelineLayout(page);
    await stubClipboard(page);
    await page.clock.install();

    await userCopy.click();
    await expect(userCopy).toHaveText("Copied");
    await expect(assistantCopy).toHaveText("Copy");
    await page.clock.fastForward(1_000);
    await expect(userCopy).toHaveText("Copied");
    await page.clock.fastForward(600);
    await expect(userCopy).toHaveText("Copy");
    await assistantCopy.click();
    await expect(assistantCopy).toHaveText("Copied");

    const codeBlocks = assistant.locator(".message__code-block");
    await expect(codeBlocks).toHaveCount(2);
    await expect(codeBlocks.first()).toContainText("python");
    for (const block of await codeBlocks.all()) {
      await expect(block.locator("pre > code")).toHaveCount(1);
      const copy = block.getByTestId("copy-code");
      await expect(copy).toHaveAttribute("aria-label", "Copy code");
      await expect(copy).toHaveAttribute("type", "button");
      await copy.click();
      await expect(copy).toHaveText("Copied");
    }
    expect(await clipboardWrites(page)).toEqual([
      userMarkdown,
      assistantMarkdown,
      pythonCode,
      unlabelledCode,
    ]);

    await stubClipboard(page, true);
    await assistantCopy.click();
    await expect(assistantCopy).toHaveText("Copy failed");
    await expect(assistantCopy).toHaveAttribute("aria-label", "Copy assistant message");
    expect(await clipboardWrites(page)).toEqual([]);
    await page.getByTestId("composer").fill("Copy failure does not block typing");
    await expect(page.getByTestId("composer")).toHaveValue("Copy failure does not block typing");
    await page.clock.fastForward(1_600);
    await expect(assistantCopy).toHaveText("Copy");
    await assistantCopy.click();
    await expect(assistantCopy).toHaveText("Copied");
    expect(await clipboardWrites(page)).toEqual([assistantMarkdown]);
  } finally {
    await harness.close();
  }
});

test("keeps copy controls keyboard accessible and transcript selection annotations usable", async () => {
  const userMarkdown = "Keyboard copy user.";
  const harness = await launchWithTranscript("message-copy-keyboard-selection", [
    { role: "user", text: userMarkdown },
    { role: "assistant", text: assistantMarkdown },
  ]);
  try {
    const page = await harness.firstWindow();
    await expect(page.locator(".timeline-item--assistant .katex")).toHaveCount(2);
    await waitForTimelineLayout(page);
    await stubClipboard(page);
    await page.getByTestId("composer").click();
    const controls = [
      {
        button: page.getByRole("button", { name: "Copy user message", exact: true }),
        text: userMarkdown,
        key: "Enter",
      },
      {
        button: page.getByRole("button", { name: "Copy assistant message", exact: true }),
        text: assistantMarkdown,
        key: "Space",
      },
      { button: page.getByTestId("copy-code").first(), text: pythonCode, key: "Enter" },
    ];
    for (const { button, key } of controls) {
      await tabTo(page, button);
      await expectVisibleKeyboardFocus(button);
      await button.press(key);
      await expect(button).toHaveText("Copied");
    }
    expect(await clipboardWrites(page)).toEqual(controls.map(({ text }) => text));

    const assistant = page.locator(".timeline-item--assistant");
    const phrase = "Select this phrase";
    await assistant.locator(".message__content p").first().scrollIntoViewIfNeeded();
    await waitForTimelineLayout(page);
    const bounds = await assistant.locator("[data-annotation-root]").evaluate((root, target) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const start = node.nodeValue?.indexOf(target) ?? -1;
        if (start < 0) continue;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + target.length);
        const box = range.getBoundingClientRect();
        return { left: box.left, right: box.right, y: box.top + box.height / 2 };
      }
      throw new Error("Missing selectable prose beside math");
    }, phrase);
    await page.mouse.move(bounds.left + 1, bounds.y);
    await page.mouse.down();
    await page.mouse.move(bounds.right - 1, bounds.y, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByTestId("copy-selection")).toBeVisible();
    await page.getByTestId("copy-selection").click();
    await expect(page.getByTestId("copy-selection")).toContainText("Copied");
    expect((await clipboardWrites(page)).at(-1)).toBe(phrase);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(phrase);
    await page.getByTestId("add-to-chat").click();
    await page
      .getByTestId("annotation-editor")
      .getByRole("textbox")
      .fill("Math context stays selectable");
    await page.getByTestId("annotation-editor").getByRole("textbox").press("Enter");
    await expect(page.getByTestId("annotation-marker")).toHaveText("1");
    await page.getByRole("button", { name: "1 annotation", exact: true }).hover();
    await expect(
      page.getByTestId("annotation-chip-popover").locator(".annotation-chip__quote"),
    ).toHaveText(phrase);
    await expect(assistant.locator(".katex")).toHaveCount(2);
  } finally {
    await harness.close();
  }
});

test("copies partial streamed math and restores Fork after the injected run completes", async () => {
  const harness = await launchWithTranscript("message-math-streaming-copy", [
    { role: "user", text: "Show the derivation." },
    { role: "assistant", text: "Earlier answer remains forkable." },
  ]);
  try {
    const page = await harness.firstWindow();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const history = page.locator(".timeline-item--assistant", { hasText: "Earlier answer" });
    const fork = history.getByTestId("fork-from-message");
    await expect(fork).toBeEnabled();
    const state = await getDesktopState(page);
    const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
    const session = workspace?.sessions.find((entry) => entry.id === state.selectedSessionId);
    if (!workspace || !session) throw new Error("Missing selected streaming fixture session");
    const sessionRef = { workspaceId: workspace.id, sessionId: session.id };
    const snapshot = {
      ref: sessionRef,
      workspace: { workspaceId: workspace.id, path: workspace.path, displayName: workspace.name },
      title: session.title,
      updatedAt: new Date().toISOString(),
      preview: "Streaming math proof",
    };
    const runId = "math-copy-stream";
    await emitTestSessionEvent(harness, {
      type: "sessionUpdated",
      sessionRef,
      runId,
      timestamp: snapshot.updatedAt,
      snapshot: { ...snapshot, status: "running", runningRunId: runId },
    });
    await expect(fork).toBeDisabled();
    await stubClipboard(page);
    let received = "";
    const emit = async (text: string) => {
      received += text;
      await emitTestSessionEvent(harness, {
        type: "assistantDelta",
        sessionRef,
        runId,
        timestamp: new Date().toISOString(),
        text,
      });
    };
    await emit("Streaming math proof: $");
    const streamed = page.locator(".timeline-item--assistant", { hasText: "Streaming math proof" });
    const copy = streamed.getByTestId("copy-message");
    await expect(streamed).toContainText("Streaming math proof: $");
    await expect(streamed.locator(".katex")).toHaveCount(0);
    await expect(copy).toBeEnabled();
    await copy.click();
    expect((await clipboardWrites(page)).at(-1)).toBe(received);
    await emit("E=mc^2$\n\n$$\n\\int_0^");
    await expect(streamed.locator(".katex")).toHaveCount(1);
    await expect(streamed).toContainText(String.raw`\int_0^`);
    await copy.click();
    expect((await clipboardWrites(page)).at(-1)).toBe(received);
    await emit(
      "1 x^2\\,dx=\\frac{1}{3}\n$$\n\nInvalid command: $\\notARealMathCommand{x}$\n\nStill usable.",
    );
    await expect(streamed.locator(".katex-display .katex")).toHaveCount(1);
    await expect(streamed).toContainText("Still usable.");
    await expect(streamed).toContainText(String.raw`\notARealMathCommand`);
    await expect(copy).toBeEnabled();
    await copy.click();
    expect((await clipboardWrites(page)).at(-1)).toBe(received);
    const partialCode = "  const pending = 1;";
    await emit(`\n\n\`\`\`ts\n${partialCode}`);
    const codeCopy = streamed.getByTestId("copy-code");
    await expect(codeCopy).toBeEnabled();
    await codeCopy.click();
    expect((await clipboardWrites(page)).at(-1)).toBe(partialCode);
    await emit("\n```\n\nCode closed.");
    await expect(streamed).toContainText("Code closed.");
    await codeCopy.click();
    expect((await clipboardWrites(page)).at(-1)).toBe(`${partialCode}\n`);
    await page.getByTestId("composer").fill("Draft while math streams");
    await expect(page.getByTestId("composer")).toHaveValue("Draft while math streams");
    await expect(fork).toBeDisabled();
    await emitTestSessionEvent(harness, {
      type: "runCompleted",
      sessionRef,
      runId,
      timestamp: new Date().toISOString(),
      snapshot: { ...snapshot, status: "idle", preview: received },
    });
    await expect(fork).toBeEnabled();
    await expect(streamed.locator(".katex-display .katex")).toHaveCount(1);
    await waitForTimelineLayout(page);
    await fork.click();
    await expect(page.getByTestId("fork-modal")).toBeVisible();
    await expect(page.getByTestId("fork-modal-preview")).toContainText(
      "Earlier answer remains forkable.",
    );
    expect(pageErrors).toEqual([]);
  } finally {
    await harness.close();
  }
});

test("keeps an annotation that crosses a code header anchored during copy feedback", async () => {
  const harness = await launchWithTranscript("message-copy-header-annotation", [
    { role: "user", text: "Explain this code." },
    { role: "assistant", text: "Before code.\n\n```python\nprint(1)\n```\n\nAfter code." },
  ]);
  try {
    const page = await harness.firstWindow();
    const assistant = page.locator(".timeline-item--assistant");
    await expect(assistant).toContainText("After code.");
    await waitForTimelineLayout(page);
    await stubClipboard(page);
    const drag = await assistant.locator("[data-annotation-root]").evaluate((root) => {
      const bounds = (text: string) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const start = node.nodeValue?.indexOf(text) ?? -1;
          if (start < 0) continue;
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + text.length);
          const box = range.getBoundingClientRect();
          return { left: box.left, right: box.right, y: box.top + box.height / 2 };
        }
        throw new Error(`Missing selection endpoint: ${text}`);
      };
      return { from: bounds("Before code."), to: bounds("print(1)") };
    });
    await page.mouse.move(drag.from.left + 1, drag.from.y);
    await page.mouse.down();
    await page.mouse.move(drag.to.right - 1, drag.to.y, { steps: 12 });
    await page.mouse.up();
    await page.getByTestId("add-to-chat").click();
    await page.getByTestId("annotation-editor").getByRole("textbox").press("Enter");
    await expect(page.getByTestId("annotation-marker")).toHaveText("1");
    await waitForTimelineLayout(page);

    const copy = assistant.getByTestId("copy-code");
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 1_000);
    await copy.click();
    // Settle annotation rendering while keeping the 1500 ms feedback timer paused;
    // background-window frame throttling must not let Copy return and hide a lost marker.
    await page.clock.runFor(32);
    await expect(copy).toHaveText("Copied");
    expect(
      await assistant.evaluate((element) => ({
        feedback: element.querySelector('[data-testid="copy-code"]')?.textContent?.trim(),
        markers: [...element.querySelectorAll('[data-testid="annotation-marker"]')].map(
          (marker) => marker.textContent,
        ),
      })),
    ).toEqual({ feedback: "Copied", markers: ["1"] });
    expect(await clipboardWrites(page)).toEqual(["print(1)\n"]);
    await page.getByRole("button", { name: "1 annotation", exact: true }).hover();
    const quote = page.getByTestId("annotation-chip-popover").locator(".annotation-chip__quote");
    await expect(quote).toContainText("Before code.");
    await expect(quote).toContainText("print(1)");
    await expect(quote).not.toContainText(/Copy|Copied|python/);
  } finally {
    await harness.close();
  }
});
