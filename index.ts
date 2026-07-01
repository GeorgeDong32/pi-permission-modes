/**
 * @aprimediet/permission-modes
 *
 * A Claude-Code-style permission-mode system for the pi coding agent.
 *
 * Three modes, cycled with Shift+Tab (ask → plan → auto → ask):
 *   - ask          File edits/writes require approval; reads outside cwd require
 *                  approval; inside-cwd reads are auto-approved; mutating bash prompts.
 *   - plan         Read-only; edit/write disabled, bash restricted to an allowlist;
 *                  produce a numbered Plan:, then Execute / Stay / Refine.
 *   - auto         Auto-approve everything and auto-continue (bounded by /auto-depth)
 *                  with an outside-cwd safety net (prompt on ops outside project root).
 *
 * v1.1.1 adds per-mode model profiles: users define named profiles in
 * `~/.pi/agent/model-profiles.json` mapping each mode to a model ID. When
 * the mode changes, the extension auto-switches the model via
 * `pi.setModel()`. The `/model-profile` command and `--model-profile` flag
 * activate profiles on the fly. The footer shows `profile:<name> ·
 * model/thinking` when a profile is active.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs"
import { homedir } from "node:os";
import {
  commandTargetsOutsideCwd,
  extractTodoItems,
  filterSkillsFromPrompt,
  findProjectRoot,
  formatCount,
  isCompletionSignal,
  isInsideProject,
  isOutsideCwd,
  isSafeCommand,
  listTrackedOutsideWrites,
  markCompletedSteps,
  popTrackedOutsideWrite,
  restoreOutsideWrite,
  trackOutsideWrite,
  type OutsideWriteSnapshot,
  type TodoItem,
} from "./utils.ts";
import {
  ensureModelProfilesConfig,
  getActiveProfileName,
  listProfiles,
  loadModelProfiles,
  parseModelId,
  profileExists,
  resolveModelForMode,
  resolveSkillFilter,
  type ModelProfile,
  type ModelProfilesConfig,
} from "./profiles.ts";

type Mode = "ask" | "plan" | "auto";

// accept-edits removed, default renamed to ask in v2.0.0.
const MODE_CYCLE: Mode[] = ["ask", "plan", "auto"];

const MODE_META: Record<Mode, { icon: string; label: string; role: string }> = {
  ask: { icon: "●", label: "Ask", role: "muted" },
  plan: { icon: "⏸", label: "Plan", role: "accent" },
  auto: { icon: "▶", label: "Auto", role: "warning" },
};

// Tools available in plan mode (edit/write are stripped).
const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls"];
const PLAN_DISABLED = new Set(["edit", "write"]);

const MODE_CONTEXT: Record<Mode, string> = {
  ask:
    "[ASK MODE] Default permission mode. File edits/writes and access outside the working directory require explicit approval before they run. Mutating shell commands require approval. Read-only access inside the working directory is auto-approved.",
  plan: `[PLAN MODE ACTIVE]
You are in a read-only exploration mode. The edit and write tools are disabled and bash is restricted to read-only commands.

Investigate as needed, then produce a detailed, numbered plan under a "Plan:" header:

Plan:
1. First step
2. Second step
...

Do NOT make any changes — only describe what you would do.`,
  auto: "[AUTO MODE ACTIVE] All tool calls are auto-approved. Work autonomously without asking for permission until the task is complete. When you write or edit files outside the working directory, the change is automatically tracked (snapshotted) so the user can roll it back with /undo-outside-writes if needed. When everything is done, say the task is complete.",
};

type Block = { block: true; reason: string } | undefined;

export default function permissionModesExtension(pi: ExtensionAPI): void {
  // ---- state -------------------------------------------------------------
  let currentMode: Mode = "ask";
  let autoFollowUpDepth = 20;
  let autoFollowUpCount = 0;
  let isStepping = false;
  let toolsBeforePlanMode: string[] | undefined;
  let planExecuting = false;
  let planTodos: TodoItem[] = [];
  let projectRoot: string | null = null;

  // ---- model-profile state -----------------------------------------------
  // activeProfile === undefined means "no profile active" — the extension
  // works as before (no auto model switching). The /model-profile command and
  // --model-profile flag set this; persistState() persists it; session_start
  // restores it and re-applies the model.
  let activeProfile: string | undefined = undefined;
  let modelProfileConfig: ModelProfilesConfig = {};

  // streaming stats (for the working-indicator readout)
  let streamStart = 0;
  let outputAtStart = 0;
  let lastTps = 0;
  let gitBranch = "";

  // ---- small helpers -----------------------------------------------------
  const isAssistant = (m: any): boolean =>
    !!m && m.role === "assistant" && Array.isArray(m.content);

  const getText = (m: any): string =>
    Array.isArray(m?.content)
      ? m.content
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text)
          .join("\n")
      : typeof m?.content === "string"
        ? m.content
        : "";

  const hasToolCalls = (m: any): boolean =>
    Array.isArray(m?.content) &&
    m.content.some(
      (c: any) =>
        c &&
        (c.type === "toolCall" ||
          c.type === "tool_call" ||
          c.type === "toolUse"),
    );

  function persistState(): void {
    pi.appendEntry("modes", {
      currentMode,
      autoFollowUpDepth,
      activeProfile,
    });
  }

  // ---- tool gating -------------------------------------------------------
  function applyToolRestrictions(): void {
    if (currentMode === "plan") {
      if (toolsBeforePlanMode === undefined)
        toolsBeforePlanMode = pi.getActiveTools();
      const kept = toolsBeforePlanMode.filter((t) => !PLAN_DISABLED.has(t));
      pi.setActiveTools([...new Set([...kept, ...PLAN_TOOLS])]);
    } else if (toolsBeforePlanMode !== undefined) {
      pi.setActiveTools(toolsBeforePlanMode);
      toolsBeforePlanMode = undefined;
    }
  }

  // ---- mode switching ----------------------------------------------------
  async function setMode(mode: Mode, ctx: ExtensionContext): Promise<void> {
    currentMode = mode;
    autoFollowUpCount = 0;
    isStepping = false;
    // A manual switch always cancels any in-flight plan execution.
    planExecuting = false;
    planTodos = [];
    if (ctx.hasUI) ctx.ui.setWidget("plan-todos", undefined);
    applyToolRestrictions();
    updateStatus(ctx);
    await applyProfileModelForMode(mode, ctx);
    persistState();
  }

  function cycleMode(ctx: ExtensionContext): void {
    const idx = MODE_CYCLE.indexOf(currentMode);
    void setMode(MODE_CYCLE[(idx + 1) % MODE_CYCLE.length], ctx);
    if (ctx.hasUI) ctx.ui.notify(`Mode: ${MODE_META[currentMode].label}`);
  }

  // ---- model profile logic ----------------------------------------------
  /**
   * Switch the active model to match the one defined in `activeProfile` for
   * the given mode. No-op when no profile is active or when the profile has
   * no mapping for the mode. All failures log a notification and keep the
   * current model — never throw, never block the user.
   */
  async function applyProfileModelForMode(
    mode: Mode,
    ctx: ExtensionContext,
  ): Promise<void> {
    // Lazy first-time activation: if nothing has been activated but a
    // config file exists on disk, try to pick up the user's `active` profile
    // (or the `default` profile) so mode switches "just work".
    if (activeProfile === undefined) {
      const cfg = loadModelProfiles();
      if (Object.keys(cfg).length === 0) return;
      const candidate = cfg.active || "default";
      if (!profileExists(cfg, candidate)) return;
      activeProfile = candidate;
      modelProfileConfig = cfg;
    }

    // Re-load lazily to pick up external edits between mode switches.
    // Then re-stamp `active` with the in-memory `activeProfile` so the
    // shared `resolveModelForMode()` helper (which reads `config.active`)
    // honors any in-memory profile switches done via `/model-profile` or
    // Alt+I — the on-disk file is NOT modified here.
    const reloaded = loadModelProfiles();
    modelProfileConfig =
      activeProfile !== undefined && reloaded.active !== activeProfile
        ? { ...reloaded, active: activeProfile }
        : reloaded;

    const modelId = resolveModelForMode(modelProfileConfig, mode);
    if (!modelId) return; // profile has no mapping for this mode — keep current model

    const parsed = parseModelId(modelId);
    if (!parsed) {
      if (ctx.hasUI)
        ctx.ui.notify(
          `Invalid model ID "${modelId}" in profile "${activeProfile}"`,
          "warning",
        );
      return;
    }

    const model = ctx.modelRegistry.find(parsed.provider, parsed.model);
    if (!model) {
      if (ctx.hasUI)
        ctx.ui.notify(`Model "${modelId}" not found in registry`, "warning");
      return;
    }

    const success = await pi.setModel(model);
    if (!success) {
      if (ctx.hasUI)
        ctx.ui.notify(`No API key available for "${modelId}"`, "warning");
      return;
    }

    if (parsed.thinkingLevel && typeof pi.setThinkingLevel === "function") {
      pi.setThinkingLevel(parsed.thinkingLevel as any);
    }
  }

  async function setActiveProfile(
    name: string,
    ctx: ExtensionContext,
  ): Promise<void> {
    const config = loadModelProfiles();
    if (!profileExists(config, name)) {
      if (ctx.hasUI) ctx.ui.notify(`Unknown profile "${name}"`, "error");
      return;
    }
    activeProfile = name;
    modelProfileConfig = config;
    await applyProfileModelForMode(currentMode, ctx);
    updateStatus(ctx);
    persistState();
    if (ctx.hasUI) ctx.ui.notify(`Profile "${name}" activated`, "info");
  }

  // ---- UI: status, footer, plan widget, working stats --------------------
  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("modes", undefined);
    const m = MODE_META[currentMode];
    ctx.ui.setWorkingIndicator({
      frames: [ctx.ui.theme.fg(m.role, "●")],
      intervalMs: 500,
    });
  }

  function shortenPath(p: string): string {
    const home = homedir();
    return p && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  }

  function installFooter(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setFooter((_tui: any, theme: any) => ({
      render(width: number): string[] {
        const m = MODE_META[currentMode];
        const cwd = shortenPath(ctx.cwd);
        const cwdText = gitBranch ? `${cwd} (${gitBranch})` : cwd;

        const ctxUsage = (ctx as any).getContextUsage?.();
        let ctxStr = "";
        if (ctxUsage && ctxUsage.tokens != null && ctxUsage.percent != null) {
          const fmtK = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`;
          ctxStr = `${fmtK(ctxUsage.tokens)}/${fmtK(ctxUsage.contextWindow)} ${ctxUsage.percent.toFixed(1)}%`;
        }

        const md = (ctx as any).model;
        let modelStr = "";
        if (md) {
          modelStr = md.name ? String(md.name) : String(md.id ?? "");
          const thinking =
            typeof (pi as any).getThinkingLevel === "function"
              ? (pi as any).getThinkingLevel()
              : undefined;
          if (thinking) modelStr += ` • ${thinking}`;
        }
        if (activeProfile) {
          modelStr = `profile:${activeProfile} · ${modelStr}`;
        }

        const cwdW = visibleWidth(cwdText);
        const ctxW = visibleWidth(ctxStr);
        const modelW = visibleWidth(modelStr);
        const modeText = `${m.icon} ${m.label} (shift+tab)`;
        const modeW = visibleWidth(modeText);

        // Wide: line1 = cwd(L) + context(centered) + model(R), line2 = mode
        if (cwdW + ctxW + modelW + 4 <= width) {
          const leftGap = Math.max(2, Math.floor((width - ctxW) / 2) - cwdW);
          const rightGap = width - cwdW - leftGap - ctxW - modelW;
          if (rightGap >= 12) {
            const line1 =
              theme.fg("muted", cwdText) +
              " ".repeat(leftGap) +
              theme.fg("dim", ctxStr) +
              " ".repeat(rightGap) +
              theme.fg("dim", modelStr);
            const line2 = theme.fg(m.role, modeText);
            return [line1, line2];
          }
        }

        // Narrow: line1 = cwd(L) + context(R), line2 = mode(L) + model(R)
        // Pre-truncate plain text to guarantee fit
        let cwdDisp = cwdText;
        let cwdDispW = cwdW;
        let ctxDisp = ctxStr;
        let ctxDispW = ctxW;
        if (cwdW + ctxW + 1 > width) {
          // cwd too long, truncate it
          cwdDisp = truncateToWidth(cwdText, Math.max(4, width - ctxW - 1));
          cwdDispW = visibleWidth(cwdDisp);
        }
        const gap1 = Math.max(1, width - cwdDispW - ctxDispW);
        const line1 =
          theme.fg("muted", cwdDisp) +
          " ".repeat(gap1) +
          theme.fg("dim", ctxDisp);

        let modeDisp = modeText;
        let modeDispW = modeW;
        let modelDisp = modelStr;
        let modelDispW = modelW;
        if (modeW + modelW + 1 > width) {
          modelDisp = truncateToWidth(modelStr, Math.max(4, width - modeW - 1));
          modelDispW = visibleWidth(modelDisp);
        }
        const gap2 = Math.max(1, width - modeDispW - modelDispW);
        const line2 =
          theme.fg(m.role, modeDisp) +
          " ".repeat(gap2) +
          theme.fg("dim", modelDisp);

        return [line1, line2];
      },
      invalidate() {},
    }));
  }

  function updatePlanWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (!planTodos.length) {
      ctx.ui.setWidget("plan-todos", undefined);
      return;
    }
    const lines = planTodos.map((t) =>
      t.completed
        ? ctx.ui.theme.fg("success", "☑ ") +
          ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(t.text))
        : `${ctx.ui.theme.fg("muted", "☐ ")}${t.text}`,
    );
    ctx.ui.setWidget("plan-todos", lines);
  }

  function computeStats(ctx: ExtensionContext): {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  } {
    const acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    try {
      for (const entry of (ctx.sessionManager as any).getBranch() ?? []) {
        if (entry?.type !== "message") continue;
        const u = entry.message?.usage;
        if (!u) continue;
        acc.input += u.input || 0;
        acc.output += u.output || 0;
        acc.cacheRead += u.cacheRead || 0;
        acc.cacheWrite += u.cacheWrite || 0;
        acc.cost += u.cost?.total || 0;
      }
    } catch {
      /* ignore */
    }
    return acc;
  }

  function renderWorkingMessage(ctx: ExtensionContext): string {
    const s = computeStats(ctx);
    const parts = [`↑${formatCount(s.input)}`, `↓${formatCount(s.output)}`];
    if (s.cacheRead) parts.push(`R${formatCount(s.cacheRead)}`);
    if (lastTps > 0) parts.push(`⚡${Math.round(lastTps)} tok/s`);
    parts.push(`$${s.cost.toFixed(3)}`);
    const usage = (ctx as any).getContextUsage?.();
    if (usage && usage.percent != null) {
      parts.push(`${Math.round(usage.percent)}% ctx`);
    }
    return `Working… (${parts.join(" · ")})`;
  }

  function refreshWorkingMessage(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setWorkingMessage(
      ctx.ui.theme.fg(MODE_META[currentMode].role, renderWorkingMessage(ctx)),
    );
  }

  // ---- prompts -----------------------------------------------------------
  async function promptApproval(
    ctx: ExtensionContext,
    tool: string,
    label: string,
  ): Promise<Block> {
    if (!ctx.hasUI)
      return {
        block: true,
        reason: `${tool} blocked: no UI available to confirm.`,
      };
    const choice = await ctx.ui.select(`Allow ${tool} ${label}?`, [
      "Allow",
      "Block",
    ]);
    if (choice !== "Allow")
      return { block: true, reason: `${tool} blocked by user` };
    return undefined;
  }

  // ---- commands / shortcut / flag ---------------------------------------
  for (const mode of ["ask", "plan", "auto"] as Mode[]) {
    pi.registerCommand(mode, {
      description: `Switch to ${MODE_META[mode].label} mode`,
      handler: async (_args, ctx) => setMode(mode, ctx),
    });
  }

  pi.registerCommand("mode", {
    description:
      "Show or set the permission mode (ask | plan | auto)",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      if (arg && (MODE_CYCLE as string[]).includes(arg)) {
        await setMode(arg as Mode, ctx);
        return;
      }
      // Accept "default" as an alias for "ask" during migration period.
      if (arg === "default") {
        await setMode("ask", ctx);
        return;
      }
      if (!ctx.hasUI) return;
      const choice = await ctx.ui.select(
        "Select mode:",
        MODE_CYCLE.map((m) => MODE_META[m].label),
      );
      const picked = MODE_CYCLE.find((m) => MODE_META[m].label === choice);
      if (picked) await setMode(picked, ctx);
    },
  });

  pi.registerCommand("auto-depth", {
    description: "Set auto-mode follow-up depth cap (0 = unlimited)",
    handler: async (args, ctx) => {
      const n = parseInt((args ?? "").trim(), 10);
      if (!Number.isNaN(n) && n >= 0) {
        autoFollowUpDepth = n;
        persistState();
        if (ctx.hasUI)
          ctx.ui.notify(`Auto follow-up depth: ${n === 0 ? "unlimited" : n}`);
      } else if (ctx.hasUI) {
        ctx.ui.notify(
          `Auto follow-up depth: ${autoFollowUpDepth === 0 ? "unlimited" : autoFollowUpDepth}`,
          "info",
        );
      }
    },
  });

  // ---- /model-profile command -------------------------------------------
  // Show, list, or activate a model profile from `~/.pi/agent/model-profiles.json`.
  pi.registerCommand("model-profile", {
    description:
      "Show or set model profile (named set of per-mode models from ~/.pi/agent/model-profiles.json)",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();

      if (!arg) {
        // No args → show interactive selector
        const config = loadModelProfiles();
        const names = listProfiles(config);
        if (!names.length) {
          if (ctx.hasUI)
            ctx.ui.notify(
              "No profiles found in ~/.pi/agent/model-profiles.json",
              "warning",
            );
          return;
        }
        if (!ctx.hasUI) return;
        const choice = await ctx.ui.select("Select model profile:", names);
        if (!choice) return;
        await setActiveProfile(choice, ctx);
        return;
      }

      if (arg === "list") {
        const config = loadModelProfiles();
        const names = listProfiles(config);
        if (!names.length) {
          if (ctx.hasUI)
            ctx.ui.notify(
              "No profiles found in ~/.pi/agent/model-profiles.json",
              "info",
            );
          return;
        }
        const activeName = getActiveProfileName(config);
        const lines = names.map((n) => {
          const p = config[n] as ModelProfile;
          const mappings = ["ask", "plan", "auto"]
            .map((m) => `${m}:${(p as any)[m] || "-"}`)
            .join(" ");
          const active = n === activeName ? " (active)" : "";
          return `${n}${active}: ${mappings}`;
        });
        pi.sendMessage(
          {
            customType: "model-profile-list",
            content: `Model profiles:\n${lines.join("\n")}`,
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }

      await setActiveProfile(arg, ctx);
    },
  });

  // ---- /outside-writes + /undo-outside-writes (NEW v1.1.3) --------------
  // Format a snapshot for display in lists/selectors.
  function formatSnapshotForDisplay(
    snap: OutsideWriteSnapshot,
    externallyModified = false,
  ): string {
    const ts = snap.timestamp.replace("T", " ").slice(0, 19);
    const action = snap.backupContent === null ? "would delete" : "would restore";
    const flag = externallyModified ? " \u26a0 externally modified" : "";
    return `${ts} \u00b7 ${snap.toolName} \u00b7 ${snap.originalPath} (${action})${flag}`;
  }

  // Detect if a file has been externally modified since its snapshot was taken.
  // Heuristic: if multiple snapshots exist for the same path, OR the current
  // file content differs from the snapshot's backupContent, the file is
  // considered externally modified.
  function isExternallyModified(
    snap: OutsideWriteSnapshot,
    allSnaps: OutsideWriteSnapshot[],
  ): boolean {
    const samePath = allSnaps.filter((s) => s.originalPath === snap.originalPath);
    if (samePath.length > 1) return true;
    try {
      const current = readFileSync(snap.originalPath, "utf-8");
      return current !== snap.backupContent;
    } catch {
      return false;
    }
  }

  pi.registerCommand("outside-writes", {
    description:
      "List tracked outside-cwd writes from auto mode (read-only; does not undo)",
    handler: async (_args, ctx) => {
      const snaps = listTrackedOutsideWrites(ctx.cwd);
      if (!snaps.length) {
        if (ctx.hasUI) ctx.ui.notify("No tracked outside-cwd writes", "info");
        return;
      }
      const lines = snaps.map((s) => formatSnapshotForDisplay(s, isExternallyModified(s, snaps)));
      pi.sendMessage(
        {
          customType: "outside-writes-list",
          content: `Tracked outside-cwd writes (${snaps.length}):\n${lines.join("\n")}`,
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("undo-outside-writes", {
    description:
      "Restore files modified by auto mode outside cwd. No args = selector; 'all' = restore all; '--list' = list only",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();

      // --list: alias for /outside-writes
      if (arg === "--list" || arg === "list") {
        const snaps = listTrackedOutsideWrites(ctx.cwd);
        if (!snaps.length) {
          if (ctx.hasUI) ctx.ui.notify("No tracked outside-cwd writes", "info");
          return;
        }
        const lines = snaps.map((s) => formatSnapshotForDisplay(s, isExternallyModified(s, snaps)));
        pi.sendMessage(
          {
            customType: "outside-writes-list",
            content: `Tracked outside-cwd writes (${snaps.length}):\n${lines.join("\n")}`,
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }

      const allSnaps = listTrackedOutsideWrites(ctx.cwd);
      if (!allSnaps.length) {
        if (ctx.hasUI)
          ctx.ui.notify("No tracked outside-cwd writes to undo", "info");
        return;
      }

      if (arg === "all") {
        // Restore all without prompting
        let restored = 0;
        let deleted = 0;
        let warned = 0;
        const externallyModifiedPaths = new Set(
          allSnaps
            .filter((s) => isExternallyModified(s, allSnaps))
            .map((s) => s.originalPath),
        );
        for (const snap of allSnaps) {
          const result = restoreOutsideWrite(snap);
          if (result.action === "restored") restored++;
          else if (result.action === "deleted") deleted++;
          if (externallyModifiedPaths.has(snap.originalPath)) warned++;
          popTrackedOutsideWrite(ctx.cwd, snap);
        }
        if (ctx.hasUI) {
          const warnMsg =
            warned > 0
              ? ` (${warned} file(s) externally modified \u2014 restored anyway)`
              : "";
          ctx.ui.notify(
            `Restored ${restored}, deleted ${deleted} tracked write(s)${warnMsg}`,
            "info",
          );
        }
        return;
      }

      // No args: interactive selector (newest first)
      if (!ctx.hasUI) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "No UI available; pass 'all' or '--list' as argument",
            "warning",
          );
        return;
      }
      const ordered = [...allSnaps].reverse();
      const choice = await ctx.ui.select(
        "Restore which tracked outside-cwd write? (newest first)",
        ordered.map((s) =>
          formatSnapshotForDisplay(s, isExternallyModified(s, allSnaps)),
        ),
      );
      if (!choice) return;
      const picked = ordered.find(
        (s) =>
          formatSnapshotForDisplay(s, isExternallyModified(s, allSnaps)) === choice,
      );
      if (!picked) return;
      const wasExternal = isExternallyModified(picked, allSnaps);
      const result = restoreOutsideWrite(picked);
      popTrackedOutsideWrite(ctx.cwd, picked);
      const action = result.action === "deleted" ? "Deleted" : "Restored";
      const warnSuffix = wasExternal
        ? " (\u26a0 file was externally modified \u2014 restored from snapshot anyway)"
        : "";
      ctx.ui.notify(`${action} ${picked.originalPath}${warnSuffix}`, "info");
    },
  });


    pi.registerShortcut("shift+tab", {
    description: "Cycle mode: Ask → Plan → Auto",
    handler: async (ctx) => cycleMode(ctx),
  });

  // Alt+T: cycle the thinking level. pi has no built-in cycle helper, and setThinkingLevel
  // clamps to the model's capabilities, so we advance to the next level the model actually
  // accepts (skipping ones it clamps away). The footer reflects the new level live.
  const THINKING_LEVELS = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ] as const;
  function cycleThinkingLevel(ctx: ExtensionContext): void {
    const get = (): string =>
      typeof (pi as any).getThinkingLevel === "function"
        ? (pi as any).getThinkingLevel()
        : "off";
    const setLevel = (pi as any).setThinkingLevel as
      | ((l: string) => void)
      | undefined;
    if (typeof setLevel !== "function") return;
    const cur = get();
    let i = THINKING_LEVELS.indexOf(cur as (typeof THINKING_LEVELS)[number]);
    if (i < 0) i = 0;
    for (let step = 1; step <= THINKING_LEVELS.length; step++) {
      const next = THINKING_LEVELS[(i + step) % THINKING_LEVELS.length];
      setLevel(next);
      const applied = get();
      if (applied !== cur) {
        if (ctx.hasUI) ctx.ui.notify(`Thinking: ${applied}`, "info");
        return;
      }
    }
    if (ctx.hasUI)
      ctx.ui.notify(
        `Thinking: ${get()} (model supports no other levels)`,
        "info",
      );
  }

  pi.registerShortcut("alt+t", {
    description:
      "Cycle thinking level (off → minimal → low → medium → high → xhigh)",
    handler: async (ctx) => cycleThinkingLevel(ctx),
  });

  // Alt+I: cycle through model profiles defined in `~/.pi/agent/model-profiles.json`.
  // Mirrors Shift+Tab's cycle-by-one behavior: starts at the profile after the
  // currently active one and wraps. Falls back to the first profile when no
  // profile is active yet. Always re-applies the model for the current mode,
  // so the UI (footer + status pill) updates immediately.
  async function cycleProfile(ctx: ExtensionContext): Promise<void> {
    const config = loadModelProfiles();
    const names = listProfiles(config);
    if (!names.length) {
      if (ctx.hasUI)
        ctx.ui.notify(
          "No profiles found in ~/.pi/agent/model-profiles.json",
          "warning",
        );
      return;
    }
    // Determine the index of the next profile. If no profile is active yet,
    // we treat the current `config.active` (or "default") as the implicit one
    // so cycling always advances.
    const currentName =
      activeProfile ?? getActiveProfileName(config) ?? names[0]!;
    let i = names.indexOf(currentName);
    if (i < 0) i = -1; // unknown current → start before the first
    const next = names[(i + 1) % names.length]!;
    await setActiveProfile(next, ctx);
  }

  pi.registerShortcut("alt+i", {
    description:
      "Cycle model profile (next profile from ~/.pi/agent/model-profiles.json)",
    handler: async (ctx) => cycleProfile(ctx),
  });

  // NB: pi has a built-in `--mode` (output mode: text/json/rpc), so the start-mode
  // flag must use a distinct name to avoid being shadowed at parse time.
  pi.registerFlag("permission-mode", {
    description:
      "Start in a permission mode: ask, plan, or auto (accepts 'default' as alias for 'ask')",
    type: "string",
    default: "ask",
  });

  pi.registerFlag("model-profile", {
    description:
      "Start with a named model profile from ~/.pi/agent/model-profiles.json",
    type: "string",
  });

  // ---- tool_call gate ----------------------------------------------------
  pi.on("tool_call", async (event, ctx): Promise<Block> => {
    const tool = event.toolName;
    const input = (event.input ?? {}) as Record<string, unknown>;

    // PLAN: edit/write already stripped via setActiveTools; defensive block in case
    // the tool still reaches us (e.g., during the same turn before activeTools is updated).
    if (currentMode === "plan") {
      if (tool === "edit" || tool === "write") {
        return {
          block: true,
          reason: `Plan mode: edit/write disabled. Use /plan to exit plan mode first.`,
        };
      }
      if (tool === "bash") {
        const cmd = String(input.command ?? "");
        if (!isSafeCommand(cmd)) {
          return {
            block: true,
            reason: `Plan mode: read-only commands only. Use /plan to exit plan mode first.\n  Command: ${cmd}`,
          };
        }
      }
      return undefined;
    }

    // AUTO: approve everything, except prompt for bash destructive outside cwd
    // that targets paths outside the detected project root. Reads are always
    // auto-approved (read-only). Edit/write outside cwd are auto-approved but
    // tracked via trackOutsideWrite() so the user can roll back via
    // /undo-outside-writes (NEW in v1.1.3).
    if (currentMode === "auto") {
      if (tool === "read" || tool === "grep" || tool === "find" || tool === "ls") {
        return undefined;
      }

      // Edit/write: auto-approve; track outside-cwd writes for undo.
      if (tool === "edit" || tool === "write") {
        const pathStr = String(input.path ?? "");
        if (pathStr && isOutsideCwd(pathStr, ctx.cwd)) {
          let backupContent: string | null = null;
          try {
            backupContent = readFileSync(pathStr, "utf-8");
          } catch {
            backupContent = null;
          }
          trackOutsideWrite(ctx.cwd, {
            timestamp: new Date().toISOString(),
            originalPath: pathStr,
            toolName: tool,
            backupContent,
          });
          if (ctx.hasUI) {
            ctx.ui.notify(
              `📝 tracked outside-cwd ${tool}: ${shortenPath(pathStr)}`,
              "info",
            );
          }
        }
        return undefined;
      }

      // Bash: destructive outside cwd still prompts (safety net unchanged).
      const cmdStr = String(input.command ?? "");
      const outside = cmdStr && commandTargetsOutsideCwd(cmdStr, ctx.cwd);
      if (outside && !isInsideProject(".", ctx.cwd, projectRoot)) {
        return promptApproval(ctx, tool, `outside cwd on "${cmdStr}"`);
      }
      return undefined;
    }

    // ASK: prompt on edit/write (with "Allow all → auto"); prompt on read outside cwd;
    // inside-cwd reads auto-approved; mutating bash prompts.
    if (currentMode === "ask") {
      // Read operations: prompt if outside cwd, auto-approve if inside cwd.
      if (tool === "read" || tool === "grep" || tool === "find" || tool === "ls") {
        const pathStr = String(input.path ?? "");
        if (pathStr && isOutsideCwd(pathStr, ctx.cwd)) {
          return promptApproval(ctx, tool, `outside cwd on "${pathStr}"`);
        }
        return undefined;
      }
      if (tool === "edit" || tool === "write") {
        const path = String(input.path ?? "(unknown)");
        if (!ctx.hasUI)
          return {
            block: true,
            reason: `${tool} blocked: no UI available to confirm.`,
          };
        const choice = await ctx.ui.select(`Allow ${tool} on ${path}?`, [
          "Allow",
          "Allow all (enable auto)",
          "Block",
        ]);
        if (choice === "Allow all (enable auto)") {
          await setMode("auto", ctx);
          return undefined;
        }
        if (choice !== "Allow")
          return { block: true, reason: `${tool} blocked by user on ${path}` };
        return undefined;
      }
      if (tool === "bash") {
        const cmd = String(input.command ?? "");
        if (isSafeCommand(cmd)) return undefined;
        return promptApproval(ctx, tool, `"${cmd}"`);
      }
      return undefined;
    }

    // Fallback: unknown tool or mode — let through.
    return undefined;
  });

  // ---- context injection + dedup ----------------------------------------
  pi.on("before_agent_start", async (event, ctx) => {
    if (planExecuting && planTodos.length) {
      const remaining = planTodos
        .filter((t) => !t.completed)
        .map((t) => `${t.step}. ${t.text}`)
        .join("\n");
      return {
        message: {
          customType: "modes-context",
          content: `[EXECUTING PLAN — full tool access]\n\nRemaining steps:\n${remaining}\n\nExecute each step in order. After finishing a step, include a [DONE:n] tag in your reply.`,
          display: false,
        },
      };
    }

    const result: {
      message?: { customType: string; content: string; display: boolean }
      systemPrompt?: string
    } = {};

    // Inject mode context
    const content = MODE_CONTEXT[currentMode];
    if (content) {
      result.message = {
        customType: "modes-context",
        content,
        display: false,
      };
    }

    // Filter skills from the system prompt when a mode-specific filter is
    // active. resolveSkillFilter returns ["*"] (allow all) when no filter is
    // configured, in which case filterSkillsFromPrompt is a no-op.
    const skillFilter = resolveSkillFilter(modelProfileConfig, currentMode);
    if (skillFilter.length !== 1 || skillFilter[0] !== "*") {
      // We have a specific skill filter — modify the system prompt.
      // event.systemPrompt is the rendered prompt; ctx.getSystemPrompt() returns
      // the current system prompt (which may have been modified by an earlier
      // extension). Prefer the event value for the first-pass read.
      const systemPrompt =
        event?.systemPrompt ?? ctx?.getSystemPrompt?.() ?? "";
      if (systemPrompt) {
        const filtered = filterSkillsFromPrompt(systemPrompt, skillFilter);
        // Defensive guard (v1.1.5): if filtering was a no-op despite a
        // non-empty, non-"*" allowlist (i.e. user explicitly named skills
        // to keep), the regex probably drifted from pi's actual
        // `formatSkillsForPrompt` schema. Surface this loudly so future
        // regressions don't ship silently like v1.1.4 did.
        //
        // We only warn when skillFilter is non-empty: `[]` is the documented
        // "allow all" sentinel and a legitimate no-op (see filterSkillsFromPrompt).
        if (
          skillFilter.length > 0 &&
          filtered === systemPrompt &&
          systemPrompt.includes("<skill")
        ) {
          console.warn(
            `[permission-modes] Skill filter for mode "${currentMode}" was a no-op ` +
              `(${skillFilter.length} skill(s) requested: ${skillFilter.join(", ")}). ` +
              `The system prompt contains <skill> blocks but none matched the filter. ` +
              `This usually means pi changed formatSkillsForPrompt() and our regex ` +
              `needs updating.`,
          );
        }
        result.systemPrompt = filtered;
      }
    }

    return Object.keys(result).length > 0 ? result : undefined;
  });

  pi.on("context", async (event) => {
    const msgs = event.messages as any[];
    let lastIdx = -1;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i]?.customType === "modes-context") lastIdx = i;
    }
    if (lastIdx === -1) return undefined;
    return {
      messages: msgs.filter(
        (m, i) => m?.customType !== "modes-context" || i === lastIdx,
      ),
    };
  });

  // ---- streaming-stat working message -----------------------------------
  pi.on("turn_start", async (_event, ctx) => {
    streamStart = Date.now();
    outputAtStart = computeStats(ctx).output;
    refreshWorkingMessage(ctx);
  });
  pi.on("before_provider_request", async (_event, ctx) =>
    refreshWorkingMessage(ctx),
  );
  pi.on("message_update", async (_event, ctx) => refreshWorkingMessage(ctx));

  // ---- turn_end: tps + plan-step tracking + auto follow-up ---------------
  pi.on("turn_end", async (event, ctx) => {
    try {
      gitBranch = (ctx.sessionManager as any).getGitBranch?.() ?? gitBranch;
    } catch {
      /* ignore */
    }

    const stats = computeStats(ctx);
    const elapsed = Math.max((Date.now() - streamStart) / 1000, 0.001);
    const delta = stats.output - outputAtStart;
    if (delta > 0) lastTps = delta / elapsed;
    refreshWorkingMessage(ctx);

    const msg = event.message;
    if (!isAssistant(msg)) return;
    const text = getText(msg);

    if (planExecuting && planTodos.length) {
      if (markCompletedSteps(text, planTodos) > 0) updatePlanWidget(ctx);
      persistState();
    }

    if (currentMode === "auto" && !isStepping) {
      if (autoFollowUpDepth > 0 && autoFollowUpCount >= autoFollowUpDepth)
        return;
      if (hasToolCalls(msg) && !isCompletionSignal(text)) {
        isStepping = true;
        autoFollowUpCount++;
        try {
          pi.sendUserMessage(
            "Continue. Auto mode is active — proceed without asking.",
            {
              deliverAs: "followUp",
            },
          );
        } catch (err) {
          // followUp delivery not supported in this pi version — disable stepping
          isStepping = false;
          console.warn("[permission-modes] auto follow-up unavailable:", err);
        }
      }
    }
  });

  // ---- agent_end: idle reset + plan complete + plan offer ----------------
  pi.on("agent_end", async (event, ctx) => {
    isStepping = false;
    if (ctx.hasUI) ctx.ui.setWorkingMessage(); // restore default loader when idle

    // Plan execution in progress: announce completion when all steps are done.
    if (planExecuting && planTodos.length) {
      if (planTodos.every((t) => t.completed)) {
        if (ctx.hasUI) {
          pi.sendMessage(
            {
              customType: "plan-complete",
              content: "**Plan Complete!** ✓",
              display: true,
            },
            { triggerTurn: false },
          );
          ctx.ui.setWidget("plan-todos", undefined);
        }
        planExecuting = false;
        planTodos = [];
        persistState();
      }
      return;
    }

    // In plan mode (and interactive): extract the plan and offer next action.
    if (currentMode !== "plan" || !ctx.hasUI) return;
    const lastAssistant = [...(event.messages as any[])]
      .reverse()
      .find(isAssistant);
    if (!lastAssistant) return;
    const extracted = extractTodoItems(getText(lastAssistant));
    if (!extracted.length) return;
    planTodos = extracted;
    persistState();

    const choice = await ctx.ui.select("Plan ready — what next?", [
      "Execute the plan",
      "Stay in plan mode",
      "Refine the plan",
    ]);

    if (choice === "Execute the plan") {
      planExecuting = true;
      currentMode = "auto";
      autoFollowUpCount = 0;
      isStepping = false;
      applyToolRestrictions(); // restores edit/write
      updateStatus(ctx);
      updatePlanWidget(ctx);
      persistState();
      await applyProfileModelForMode("auto", ctx);
      const steps = planTodos.map((t) => `${t.step}. ${t.text}`).join("\n");
      pi.sendMessage(
        {
          customType: "modes-execute",
          content: `Execute the plan now. Steps:\n${steps}\n\nStart with step 1. After finishing each step, include a [DONE:n] tag in your reply.`,
          display: true,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } else if (choice === "Refine the plan") {
      const refinement = await ctx.ui.editor("Refine the plan:", "");
      if (refinement && refinement.trim()) {
        pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
      }
    }
  });

  // ---- session start / resume -------------------------------------------
  async function onSessionStart(
    _event: unknown,
    ctx: ExtensionContext,
  ): Promise<void> {
    // Ensure the model profiles config exists (creates ~/.pi/agent if missing
    // and writes a default file with the user's default model detected from
    // settings.json). Re-runs on /reload so a user-deleted file is recreated.
    modelProfileConfig = ensureModelProfilesConfig();

    const flag = pi.getFlag("permission-mode");
    if (typeof flag === "string") {
      if ((MODE_CYCLE as string[]).includes(flag)) {
        currentMode = flag as Mode;
      } else if (flag === "default" || flag === "accept-edits") {
        currentMode = "ask";
      }
    }

    // --model-profile <name>: validate and activate the named profile.
    const profileFlag = pi.getFlag("model-profile");
    if (typeof profileFlag === "string" && profileFlag) {
      const config = loadModelProfiles();
      if (profileExists(config, profileFlag)) {
        activeProfile = profileFlag;
        modelProfileConfig = config;
      } else if (ctx.hasUI) {
        ctx.ui.notify(
          `Unknown profile "${profileFlag}". Available: ${listProfiles(config).join(", ") || "(none)"}`,
          "warning",
        );
      }
    }

    // Restore the latest persisted mode entry (overrides the flag).
    try {
      const entries = (ctx.sessionManager as any).getEntries?.() ?? [];
      const last = [...entries]
        .reverse()
        .find((e: any) => e?.type === "custom" && e?.customType === "modes");
      if (last?.data) {
        let m = last.data.currentMode;
        if (m === "normal") m = "default";      // legacy (v0.x)
        if (m === "default") m = "ask";          // v1.0.0 → v2.0.0 rename
        if (m === "accept-edits") m = "ask";     // removed mode → fall back to ask
        if ((MODE_CYCLE as string[]).includes(m)) currentMode = m;
        if (typeof last.data.autoFollowUpDepth === "number")
          autoFollowUpDepth = last.data.autoFollowUpDepth;
        if (typeof last.data.activeProfile === "string")
          activeProfile = last.data.activeProfile;
      }
    } catch {
      /* ignore */
    }

    try {
      gitBranch = (ctx.sessionManager as any).getGitBranch?.() ?? "";
    } catch {
      /* ignore */
    }

    // Cache the project root once per session.
    if (projectRoot === null) {
      try {
        projectRoot = findProjectRoot(ctx.cwd);
      } catch {
        projectRoot = null;
      }
    }

    applyToolRestrictions();
    if (ctx.hasUI) {
      installFooter(ctx);
      updateStatus(ctx);
    }

    // If a profile was activated (via flag or persisted state), apply its
    // model mapping for the current mode.
    if (activeProfile) {
      await applyProfileModelForMode(currentMode, ctx);
    }
  }

  pi.on("session_start", onSessionStart);
  pi.on("session_tree", onSessionStart);
}
