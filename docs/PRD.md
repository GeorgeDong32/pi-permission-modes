# Product Requirements Document: permission-modes

**Version:** 2.1
**Date:** 2026-06-28
**Status:** Implemented

## Overview
A Claude-Code-style permission-mode system for the pi coding agent. Three modes — ask, plan, and auto — cycled with Shift+Tab — that control how tool calls and file edits get approved without changing the underlying model. Outside-cwd read guarding protects against data exfiltration in ask mode; auto mode provides an outside-cwd safety net for destructive operations.

## Problem Statement
The pi coding agent lacks granular permission controls during a session. Users who want different levels of autonomy — from full manual approval for every edit to completely hands-off execution — have no way to switch. This friction makes pi less productive than tools like Claude Code that offer mode-based workflows.

## Goals
- Provide three distinct permission modes that control how tool calls (edit, write, bash) are approved
- Let users cycle modes easily via Shift+Tab keyboard shortcut
- Show the current mode in the UI via a custom adaptive footer (v1.1.6: context usage + two-line layout)
- Persist the current mode and auto-follow-up depth across session restarts
- In Plan mode: restrict to read-only exploration, produce a structured plan, then optionally execute it step by step with [DONE:n] tracking
- Optionally swap the AI model per mode via user-defined model profiles stored at `~/.pi/agent/model-profiles.json`

## Non-Goals
- Safety guardrails (out of scope — this extension only manages approval behavior, not model-level safety)
- Replacing pi's built-in `--mode` flag for output format (text/json/rpc)
- Providing a full CLI or standalone application (this is a pi extension only)
- Auto-switching models without an explicit user-defined profile (no implicit mode→model mapping; the extension only acts when the user has opted in via the config file)

## Target Users
- Developers who use the pi coding agent for daily development
- Users who want a Claude-Code-like permission workflow in pi
- Developers who want to switch between exploratory (plan) and autonomous (auto) modes within the same session

## Key Features

### Permission Mode Switching
Cycle through three modes with Shift+Tab: Ask (prompt on edits + reads outside cwd) → Plan (read-only) → Auto (full autonomy with outside-cwd safety net). Also available as slash commands (`/ask`, `/plan`, `/auto`, `/mode`; `/default` works as alias for `/ask`).

### Plan Mode with Todo Tracking
In Plan mode, edits and writes are disabled and bash is restricted to read-only commands. After exploration, the agent emits a numbered `Plan:` list. The user can execute the plan (switches to auto mode with step tracking via `[DONE:n]` tags), stay in plan mode, or refine the plan.

### Per-Mode Model Profiles (v1.1.1)
Users define named profiles in `~/.pi/agent/model-profiles.json` mapping each mode (ask / plan / auto) to a model ID (`"provider/model"` or `"provider/model:thinking"`). When the mode changes, the extension auto-switches the model via `pi.setModel()`. Profiles are activated via `/model-profile` (with optional selector or `<name>` argument) or the `--model-profile <name>` start flag, and persisted across session resume. The footer shows `profile:<name> · model/thinking` when a profile is active. Lazy re-read on every mode switch picks up edits to the config without requiring `/reload`.

### Outside-Cwd Write Tracking (v1.1.3)
Auto mode now auto-approves `edit`/`write` outside the working directory but snapshots each one to `<cwd>/.pi/projects/<id>/tmp/outside-writes/` for potential rollback. Use `/undo-outside-writes` to restore or `/outside-writes` to list tracked writes. The snapshot captures the file's pre-write content (or `null` if the file didn't exist). Snapshots are capped at 100 entries (LRU eviction).

### UI Integration
An adaptive custom footer (v1.1.6) shows cwd [git-branch], context usage (`tokens/contextWindow percent`), and model/thinking-level (or `profile:name · model/thinking-level` when a profile is active). Wide terminals use a two-line layout (info row + mode row); narrow terminals reflow with truncation. Mode is color-coded (ask=muted, plan=accent, auto=warning). The colored status pill was removed in v1.1.6. During execution, live token stats and context usage are shown in the working indicator.

### Keybinding
Shift+Tab cycles permission modes; Alt+T cycles the thinking level (off → minimal → low → medium → high → xhigh). Both are custom keybindings that integrate with pi's shortcut system.

### Persistence
The current mode, auto-mode follow-up depth cap, and active profile name are persisted across `/reload` and session resume via pi's entry storage.

## Success Metrics
- Users can switch modes as easily as they do in Claude Code
- No friction switching between exploratory (plan) and autonomous (auto) workflows
- The footer always reflects the correct current mode, profile, and context usage

## Scope & Boundaries
- **In scope:** A pi extension that intercepts `tool_call` events to gate approvals, injects mode-specific context into the agent loop, and provides UI feedback via pi's extension API
- **In scope:** Commands, shortcuts, and start-up flags (`--permission-mode`, `--model-profile`) to select the initial mode / profile
- **Out of scope:** Any changes to pi's core or safety guardrails
- **In scope (v1.1.1):** Optional `pi.setModel()` calls driven by user-defined profile config — but only when the user has opted in via `~/.pi/agent/model-profiles.json`
- **Out of scope:** Third-party dependencies beyond pi's core peer packages (@earendil-works/pi-coding-agent, @earendil-works/pi-ai, @earendil-works/pi-tui, typebox)

## Open Questions
- None at this time.

## Commands (v1.1.3)

| Command | Behavior |
|---|---|
| `/outside-writes` | List tracked outside-cwd writes from auto mode (read-only) |
| `/undo-outside-writes` | Restore files modified by auto mode outside cwd (selector, `all`, or `--list`) |
| `/undo-outside-writes all` | Restore all tracked writes without prompting |
| `/undo-outside-writes --list` | Alias for `/outside-writes` |
