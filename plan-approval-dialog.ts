import {
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  type Component,
  type MarkdownTheme,
  type TUI,
} from "@earendil-works/pi-tui";

export type PlanApprovalChoice = "execute" | "refine" | "stay" | "cancel";

export const MAX_PLAN_CHARS = 200_000;
export const MIN_PLAN_VIEWPORT_LINES = 6;
export const FULLSCREEN_CHROME_RESERVE = 14;

const OPTIONS = [
  { label: "Execute the plan", choice: "execute" as const },
  { label: "Refine the plan", choice: "refine" as const },
  { label: "Stay in plan mode", choice: "stay" as const },
];

const FOOTER = "scroll: mouse · ↑/↓ select · PgUp/PgDn plan · Enter confirm · Esc close";
const WHEEL_SCROLL_LINES = 3;
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1006l";

export function computeMaxRenderLines(termRows: number): number {
  return Math.max(1, termRows);
}

export function computePlanViewportLines(termRows: number, hasSummary = false): number {
  const fixedChrome = FULLSCREEN_CHROME_RESERVE + (hasSummary ? 1 : 0);
  return Math.max(MIN_PLAN_VIEWPORT_LINES, termRows - fixedChrome);
}

export function truncatePlanContent(planContent: string): {
  text: string;
  truncated: boolean;
} {
  if (planContent.length <= MAX_PLAN_CHARS) {
    return { text: planContent, truncated: false };
  }
  return {
    text: planContent.slice(0, MAX_PLAN_CHARS),
    truncated: true,
  };
}

/** Returns -1 for wheel up, +1 for wheel down, 0 if not a wheel event. */
export function parseMouseWheelDelta(input: string): number {
  const sgr = SGR_MOUSE_RE.exec(input);
  if (sgr) {
    const button = Number.parseInt(sgr[1]!, 10);
    if ((button & 0x43) === 0x40) return -1;
    if ((button & 0x43) === 0x41) return 1;
    return 0;
  }

  if (input.length === 6 && input.startsWith("\x1b[M")) {
    const button = input.charCodeAt(3) - 32;
    if ((button & 0x43) === 0x40) return -1;
    if ((button & 0x43) === 0x41) return 1;
  }

  return 0;
}

function createMarkdownTheme(theme: Theme): MarkdownTheme {
  const text = (value: string) => theme.fg("text", value);
  return {
    heading: (value) => theme.bold(value),
    link: (value) => theme.fg("mdLink", value),
    linkUrl: (value) => theme.fg("mdLinkUrl", value),
    code: (value) => theme.fg("mdCode", value),
    codeBlock: text,
    codeBlockBorder: (value) => theme.fg("mdCodeBlockBorder", value),
    quote: (value) => theme.fg("mdQuote", value),
    quoteBorder: (value) => theme.fg("mdQuoteBorder", value),
    hr: (value) => theme.fg("mdHr", value),
    listBullet: (value) => theme.fg("mdListBullet", value),
    bold: (value) => theme.bold(value),
    italic: (value) => theme.italic(value),
    strikethrough: (value) => theme.strikethrough(value),
    underline: (value) => theme.underline(value),
  };
}

export interface PlanApprovalDialogOptions {
  planContent: string;
  summary?: string;
  stepCount: number;
  theme: Theme;
  tui: TUI;
  done: (choice: PlanApprovalChoice) => void;
}

export function createPlanApprovalComponent(
  options: PlanApprovalDialogOptions,
): Component & { dispose?(): void } {
  return new PlanApprovalComponent(options);
}

export async function runPlanApprovalDialog(
  ctx: ExtensionContext,
  options: {
    summary?: string;
    planContent: string;
    stepCount: number;
  },
): Promise<PlanApprovalChoice> {
  return ctx.ui.custom<PlanApprovalChoice>(
    (tui, theme, _kb, done) =>
      createPlanApprovalComponent({
        planContent: options.planContent,
        summary: options.summary,
        stepCount: options.stepCount,
        theme,
        tui,
        done,
      }),
  );
}

class PlanApprovalComponent implements Component {
  private readonly summary?: string;
  private readonly stepCount: number;
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly done: (choice: PlanApprovalChoice) => void;
  private readonly markdown: Markdown;
  private readonly truncated: boolean;
  private scrollOffset = 0;
  private selectedIndex = 0;
  private cachedLines: string[] | undefined;
  private cachedWidth: number | undefined;
  private disposed = false;

  constructor(options: PlanApprovalDialogOptions) {
    this.summary = options.summary?.trim() || undefined;
    this.stepCount = options.stepCount;
    this.theme = options.theme;
    this.tui = options.tui;
    this.done = options.done;

    const { text, truncated } = truncatePlanContent(options.planContent);
    this.truncated = truncated;
    this.markdown = new Markdown(
      text,
      1,
      0,
      createMarkdownTheme(options.theme),
      { color: (s) => this.theme.fg("text", s) },
    );
    this.tui.terminal.write(MOUSE_ENABLE);
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
    this.markdown.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tui.terminal.write(MOUSE_DISABLE);
  }

  handleInput(keyData: string): void {
    if (this.disposed) return;

    const kb = getKeybindings();
    const width = Math.max(20, this.tui.terminal.columns);
    const viewportLines = computePlanViewportLines(
      this.tui.terminal.rows,
      !!this.summary,
    );

    const wheelDelta = parseMouseWheelDelta(keyData);
    if (wheelDelta !== 0) {
      this.scrollPlan(wheelDelta * WHEEL_SCROLL_LINES, width, viewportLines);
      return;
    }

    if (matchesKey(keyData, Key.pageUp)) {
      this.scrollPlan(-viewportLines, width, viewportLines);
      return;
    }
    if (matchesKey(keyData, Key.pageDown)) {
      this.scrollPlan(viewportLines, width, viewportLines);
      return;
    }

    if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
      this.selectedIndex = Math.min(OPTIONS.length - 1, this.selectedIndex + 1);
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
      this.finish(OPTIONS[this.selectedIndex]?.choice ?? "stay");
      return;
    }

    if (kb.matches(keyData, "tui.select.cancel")) {
      this.finish("cancel");
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const termRows = this.tui.terminal.rows;
    const maxRenderLines = computeMaxRenderLines(termRows);
    const viewportLines = computePlanViewportLines(termRows, !!this.summary);
    const innerWidth = Math.max(20, width - 2);
    const planLines = this.getPlanLines(width);
    const maxScroll = Math.max(0, planLines.length - viewportLines);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);

    const accent = (text: string) => this.theme.fg("accent", text);
    const muted = (text: string) => this.theme.fg("muted", text);
    const dim = (text: string) => this.theme.fg("dim", text);
    const bold = (text: string) => this.theme.bold(text);
    const border = (text: string) => this.theme.fg("border", text);

    const lines: string[] = [];
    const push = (line: string) => {
      lines.push(truncateToWidth(line, innerWidth, "…", true));
    };

    push(border("─".repeat(innerWidth)));

    push(accent(bold(`Plan ready (${this.stepCount} steps)`)));
    if (this.summary) {
      push(muted(this.summary));
    }

    push(dim("─".repeat(Math.min(innerWidth, 60))));

    if (this.truncated) {
      push(this.theme.fg("warning", "… truncated, see plan.md for full content"));
    }

    if (planLines.length > viewportLines) {
      const start = this.scrollOffset + 1;
      const end = Math.min(this.scrollOffset + viewportLines, planLines.length);
      push(dim(`▲ plan ${start}-${end}/${planLines.length} · mouse/PgUp/PgDn`));
    }

    const visiblePlan = planLines.slice(
      this.scrollOffset,
      this.scrollOffset + viewportLines,
    );
    for (const line of visiblePlan) {
      push(line);
    }

    if (planLines.length > viewportLines && this.scrollOffset < maxScroll) {
      push(dim(`▼ ${planLines.length - (this.scrollOffset + viewportLines)} more lines`));
    }

    push(dim("─".repeat(Math.min(innerWidth, 60))));

    for (let i = 0; i < OPTIONS.length; i++) {
      const opt = OPTIONS[i]!;
      const selected = i === this.selectedIndex;
      const prefix = selected ? accent("→ ") : "  ";
      const label = selected ? accent(opt.label) : this.theme.fg("text", opt.label);
      push(prefix + label);
    }

    push(dim(FOOTER));
    push(border("─".repeat(innerWidth)));

    while (lines.length < maxRenderLines) {
      lines.push("");
    }

    if (lines.length > maxRenderLines) {
      this.cachedLines = lines.slice(0, maxRenderLines);
    } else {
      this.cachedLines = lines;
    }
    this.cachedWidth = width;
    return this.cachedLines;
  }

  private getPlanLines(width: number): string[] {
    const innerWidth = Math.max(20, width - 4);
    return this.markdown.render(innerWidth);
  }

  private scrollPlan(delta: number, width: number, viewportLines: number): void {
    const planLines = this.getPlanLines(width);
    const maxScroll = Math.max(0, planLines.length - viewportLines);
    this.scrollOffset = Math.max(0, Math.min(maxScroll, this.scrollOffset + delta));
    this.invalidate();
    this.tui.requestRender();
  }

  private finish(choice: PlanApprovalChoice): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tui.terminal.write(MOUSE_DISABLE);
    this.done(choice);
  }
}
