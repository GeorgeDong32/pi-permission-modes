import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import {
  computeMaxRenderLines,
  computePlanViewportLines,
  createPlanApprovalComponent,
  FULLSCREEN_CHROME_RESERVE,
  MAX_PLAN_CHARS,
  MIN_PLAN_VIEWPORT_LINES,
  parseMouseWheelDelta,
  truncatePlanContent,
} from "./plan-approval-dialog.ts";

function makeMockTheme(): Theme {
  return {
    fg: (_role: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    strikethrough: (text: string) => text,
    underline: (text: string) => text,
  } as Theme;
}

function makeMockTui(rows: number, columns = 80): TUI {
  return {
    terminal: {
      rows,
      columns,
      write: () => {},
    },
    requestRender: () => {},
  } as TUI;
}

describe("plan-approval-dialog layout helpers", () => {
  it("computePlanViewportLines uses half-terminal budget minus chrome", () => {
    const viewport = computePlanViewportLines(40);
    expect(viewport).toBeGreaterThanOrEqual(MIN_PLAN_VIEWPORT_LINES);
    expect(viewport).toBe(computeMaxRenderLines(40) - FULLSCREEN_CHROME_RESERVE);
  });

  it("computeMaxRenderLines caps around half the terminal height", () => {
    expect(computeMaxRenderLines(40)).toBeLessThanOrEqual(20);
    expect(computeMaxRenderLines(24)).toBeLessThanOrEqual(24);
    expect(computeMaxRenderLines(24)).toBeGreaterThanOrEqual(MIN_PLAN_VIEWPORT_LINES);
  });

  it("truncatePlanContent leaves short plans untouched", () => {
    const result = truncatePlanContent("hello");
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("hello");
  });

  it("truncatePlanContent caps oversized plans", () => {
    const huge = "x".repeat(MAX_PLAN_CHARS + 1);
    const result = truncatePlanContent(huge);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(MAX_PLAN_CHARS);
  });

  it("parseMouseWheelDelta recognizes SGR and X10 wheel events", () => {
    expect(parseMouseWheelDelta("\x1b[<64;12;5M")).toBe(-1);
    expect(parseMouseWheelDelta("\x1b[<65;12;5M")).toBe(1);
    expect(parseMouseWheelDelta("\x1b[M" + String.fromCharCode(32 + 64, 32 + 12, 32 + 5))).toBe(-1);
    expect(parseMouseWheelDelta("\x1b[A")).toBe(0);
  });
});

describe("plan-approval-dialog component", () => {
  it("render output stays within half-terminal budget and keeps options at the bottom", () => {
    const termRows = 24;
    const tui = makeMockTui(termRows);
    const planContent = `**Plan:**\n${Array.from({ length: 500 }, (_, i) => `${i + 1}. Implement feature number ${i + 1} ${"A".repeat(120)}`).join("\n")}`;

    const component = createPlanApprovalComponent({
      planContent,
      stepCount: 500,
      theme: makeMockTheme(),
      tui,
      done: () => {},
    });

    const lines = component.render(80);
    const maxLines = computeMaxRenderLines(termRows);
    expect(lines.length).toBeLessThanOrEqual(maxLines);
    expect(lines.length).toBeLessThan(termRows);
    // No trailing blank padding that would float options mid-screen
    expect(lines[lines.length - 1]?.trim().length).toBeGreaterThan(0);
    expect(lines.some((line) => line.includes("Stay in plan mode"))).toBe(true);
    expect(lines.some((line) => line.includes("Execute the plan"))).toBe(true);
  });

  it("render output stays within terminal line budget for large plans", () => {
    const termRows = 24;
    const tui = makeMockTui(termRows);
    const planContent = `**Plan:**\n${Array.from({ length: 500 }, (_, i) => `${i + 1}. Implement feature number ${i + 1} ${"A".repeat(120)}`).join("\n")}`;

    let resolved: string | undefined;
    const component = createPlanApprovalComponent({
      planContent,
      stepCount: 500,
      theme: makeMockTheme(),
      tui,
      done: (choice) => {
        resolved = choice;
      },
    });

    const lines = component.render(80);
    expect(lines.length).toBeLessThanOrEqual(computeMaxRenderLines(termRows));
    expect(resolved).toBeUndefined();
  });

  it("shows truncation notice for oversized plans", () => {
    const tui = makeMockTui(30);
    const huge = "# Plan\n" + "step\n".repeat(MAX_PLAN_CHARS / 4);
    const component = createPlanApprovalComponent({
      planContent: huge,
      stepCount: 3,
      theme: makeMockTheme(),
      tui,
      done: () => {},
    });

    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("truncated, see plan.md");
  });

  it("scrollOffset stays within bounds when scrolling", () => {
    const tui = makeMockTui(24);
    const planContent = `**Plan:**\n${Array.from({ length: 80 }, (_, i) => `${i + 1}. Implement feature number ${i + 1}`).join("\n")}`;
    const component = createPlanApprovalComponent({
      planContent,
      stepCount: 80,
      theme: makeMockTheme(),
      tui,
      done: () => {},
    });

    const initial = component.render(80);
    expect(initial.some((line) => line.includes("plan 1-"))).toBe(true);

    for (let i = 0; i < 50; i++) {
      component.handleInput?.("\x1b[6~"); // PageDown
    }
    const afterScroll = component.render(80);
    expect(afterScroll.length).toBeLessThanOrEqual(computeMaxRenderLines(24));
    expect(afterScroll.join("\n")).not.toContain("plan 1-");

    for (let i = 0; i < 50; i++) {
      component.handleInput?.("\x1b[5~"); // PageUp
    }
    const backToTop = component.render(80);
    expect(backToTop.some((line) => line.includes("plan 1-"))).toBe(true);
  });

  it("arrow keys switch options without scrolling the plan", () => {
    const tui = makeMockTui(24);
    const planContent = `**Plan:**\n${Array.from({ length: 80 }, (_, i) => `${i + 1}. Implement feature number ${i + 1}`).join("\n")}`;
    const component = createPlanApprovalComponent({
      planContent,
      stepCount: 80,
      theme: makeMockTheme(),
      tui,
      done: () => {},
    });

    for (let i = 0; i < 10; i++) {
      component.handleInput?.("\x1b[6~"); // PageDown to scroll plan
    }
    const scrolled = component.render(80).join("\n");
    expect(scrolled).not.toContain("plan 1-");

    component.handleInput?.("\x1b[B"); // down arrow -> select next option
    const afterArrow = component.render(80).join("\n");
    expect(afterArrow).toContain("→ Refine the plan");
    expect(afterArrow).not.toContain("plan 1-");
  });

  it("mouse wheel scrolls the plan content", () => {
    const tui = makeMockTui(24);
    const planContent = `**Plan:**\n${Array.from({ length: 80 }, (_, i) => `${i + 1}. Implement feature number ${i + 1}`).join("\n")}`;
    const component = createPlanApprovalComponent({
      planContent,
      stepCount: 80,
      theme: makeMockTheme(),
      tui,
      done: () => {},
    });

    expect(component.render(80).some((line) => line.includes("plan 1-"))).toBe(true);
    component.handleInput?.("\x1b[<65;12;5M");
    const afterWheel = component.render(80).join("\n");
    expect(afterWheel).not.toContain("plan 1-");
  });

  it("Enter confirms the selected option", () => {
    const tui = makeMockTui(24);
    let resolved: string | undefined;
    const component = createPlanApprovalComponent({
      planContent: "**Plan:**\n1. Implement the first feature step",
      stepCount: 1,
      theme: makeMockTheme(),
      tui,
      done: (choice) => {
        resolved = choice;
      },
    });

    component.handleInput?.("j");
    component.handleInput?.("\n");
    expect(resolved).toBe("refine");
  });

  it("Esc closes the dialog with cancel", () => {
    const tui = makeMockTui(24);
    let resolved: string | undefined;
    const component = createPlanApprovalComponent({
      planContent: "**Plan:**\n1. Implement the first feature step",
      stepCount: 1,
      theme: makeMockTheme(),
      tui,
      done: (choice) => {
        resolved = choice;
      },
    });

    component.handleInput?.("\x1b");
    expect(resolved).toBe("cancel");
  });
});
