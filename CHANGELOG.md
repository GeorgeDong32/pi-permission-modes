## [2.4.0] - 2026-07-25

### Added
- **CC-aligned auto security stack**: deny-and-continue on classifier blocks, fail-closed (`classifier.failClosed`, default `true`) when classifier is unavailable, denial tracking (3 consecutive / 20 total → manual UI).
- **Classifier pipelines** (`classifier.stage`: `tool` | `single` | `fast` | `both` | `thinking`, default `tool`). `tool` uses CC-style forced `classify_result` tool call with API thinking disabled; XML stages use fast-screen + optional CoT escalation in `classifier-client.ts`.
- **`classifier-tool.ts`**: `classify_result` tool schema aligned with Claude Code auto-mode classifier.
- **Model ref stage suffix**: `provider/model@tool` (or `@single`, `@fast`, `@both`, `@thinking`) overrides `classifier.stage` for per-model pipeline selection.
- **`dangerous-permissions.ts`**: strips broad/dangerous `allow` rules (e.g. `Bash(*)`, `Bash(python:*)`) on auto mode entry; restores on exit.
- **`classifier-messages.ts`**, **`denial-tracking.ts`**, **`injection-probe.ts`**: CC-style rejection messages, denial counters, and tool-output injection warnings.
- **`classifier.includeAgentsMd`** config (default `true`); agents config cannot override deny rules in classifier prompt.
- **`parseModelRef`** supports `:thinking` / `:high` profile suffixes.

### Changed
- **Breaking: tighter auto tiers** — `curl`/`wget` removed from tier-1; `npm install`, `git fetch/pull`, arbitrary `node`/`python`, `docker pull` removed from tier-2. These now require classifier (tier-3) or manual approval.
- **Classifier block** no longer opens approval UI by default; returns structured deny-and-continue message to the agent.
- **Classifier failure** no longer fail-opens to local rules when `failClosed` is true (default).

### Migration
1. Expect more tier-3 reviews for network and package-install commands in auto mode.
2. Broad `Bash(*)` / interpreter allow rules are ignored while in auto mode (restored when leaving auto).
3. Ensure classifier model is configured and `timeoutMs` ≥ 20000 for remote providers.
4. Default classifier pipeline is `tool` (forced `classify_result`). Use `classifier.stage: "single"` for free-form JSON, or `@both` / `stage: "both"` for CC XML two-stage. Append `@tool` on `classifier.model` to force tool mode for one model without changing global config.

[2.4.0]: https://github.com/GeorgeDong32/pi-permission-modes/compare/v2.3.0...v2.4.0

## [2.3.0] - 2026-07-25

### Added
- **`plan_ready` tool** for model-initiated plan submission in plan mode.
- **Full plan display** in the plan approval dialog.

### Changed
- Plan mode: cooldown, richer prompt, and `/plan-execute` improvements.

[2.3.0]: https://github.com/GeorgeDong32/pi-permission-modes/compare/v2.2.0...v2.3.0

## [2.2.0] - 2026-07-25

### Added
- **Auto mode 4-tier gate** with broader auto-approve patterns and classifier hardening.

[2.2.0]: https://github.com/GeorgeDong32/pi-permission-modes/compare/v2.1.0...v2.2.0

## [2.1.0] - 2026-07-15

### Added
- **CC-style permission rules** (`permissions.ts`, `permissions-loader.ts`, `permission-rule-parser.ts`, `shell-rule-matching.ts`, `bash-permission-match.ts`, `path-permission-match.ts`): `allow` / `deny` / `ask` lists with `Tool(specifier)` syntax aligned to Claude Code.
- **Three config scopes**: global (`~/.pi/agent/permission-modes.json`), project (`<cwd>/.pi/projects/<id>/permissions.json`), local (`permissions.local.json`).
- **`/permissions`** command to list merged rules.
- **Approval persistence**: "Allow always (this project)" and "Allow always (global)" on permission prompts.

### Changed
- **Tool gate**: configured rules run before mode gate (bypass exempt). `allow` skips mode prompts; `deny` always blocks; `ask` forces approval.
- **Auto mode**: risky ops prompt with allow-always options (replacing hard-block-only for tier-3 in recent builds).

### Notes
- Total tests: **275 passing**.
- Bash rule matching: deny/ask evaluate compound commands per segment; allow does not match compound commands (CC security model).

[2.1.0]: https://github.com/GeorgeDong32/pi-permission-modes/compare/v2.0.0...v2.1.0

## [2.0.0] - 2026-07-11

### Added
- **Fourth mode: `bypass`** — full auto-approve (v1.1.6 auto semantics). Cycle is now `ask → plan → auto → bypass → ask` (Shift+Tab). Sparse security reminder on mode switch and after `session_compact`.
- **Built-in auto classifier** (`classifier-client.ts`): optional LLM review for tier-3 tool calls via `completeSimple` from `@earendil-works/pi-ai/compat` with auth from `ctx.modelRegistry.getApiKeyAndHeaders()`. Config: `~/.pi/agent/permission-modes.json` (`classifier.enabled` defaults to `false`).
- **Plan file driver**: plan content lives at `<cwd>/.pi/projects/<projectId>/plan.md`; injection is path-only. Plan mode allows `edit`/`write` on that file only.
- **System prompt anchor injection** (`<!-- permission-modes:context -->`) replaces per-turn `modes-context` messages.
- **`AUTO_RISK_PATTERNS` blacklist** as permanent auto-mode fallback when classifier is off or fails.

### Changed
- **Breaking: `auto` semantics** — tiered auto-approve (read → cwd writes → classifier/blacklist for risky ops). Old full-auto behavior is **`bypass`**.
- **Breaking: removed `/auto-depth`** and per-turn `"Continue..."` synthetic follow-ups.
- **Ask "Allow all"** now switches to **bypass** (not auto).
- **`profiles.ts`**: `bypass` mode supported in model profiles.

### Removed
- `modes-context` injection on every turn (legacy `context` dedup hook retained for old sessions).

### Notes
- Total tests: **201 passing**.
- Migration: sessions restored with `currentMode: "auto"` get the **new** auto (not full bypass). Use `/bypass` for unrestricted auto-approve.

[2.0.0]: https://github.com/GeorgeDong32/pi-permission-modes/compare/v1.1.6...v2.0.0

## [1.1.6] - 2026-07-01

### Added
- **Adaptive footer layout**: Wide terminals show cwd (left) · context usage (center) · model/profile (right) on line 1, mode on line 2. Narrow terminals reflow to cwd + context on line 1, mode + model on line 2, with truncation to prevent overflow.
- **Context usage in footer**: Displays `tokens/contextWindow percent` via `ctx.getContextUsage()` (e.g. `42k/200k 21.0%`). Large counts use an `M` suffix (e.g. `1.0M`).

### Fixed
- **Narrow-terminal crash**: Footer layout no longer computes negative gaps when the terminal is too narrow — pre-truncates text and uses `Math.max(1, …)` for spacing.

### Changed
- **Removed colored status pill**: `ctx.ui.setStatus("modes", undefined)` — mode is shown only in the custom footer (working indicator `●` remains).
- **Mode colors**: plan uses `accent`, auto uses `warning` (swapped from v1.1.5).
- **npm scope**: Package renamed from `@aprimediet/permission-modes` to `@georgedong32/permission-modes`. Old scope remains on npm as a separate line; new installs should use `@georgedong32/permission-modes`.
- **`package.json`**: Added `repository`, `bugs`, `homepage`, and `publishConfig` metadata.

### Notes
- Total tests: **189 passing** (unchanged from v1.1.5).
- Git tag: `v1.1.6`.

[1.1.6]: https://github.com/GeorgeDong32/pi-permission-modes/compare/v1.1.5...v1.1.6

## [1.1.5] - 2026-06-29

### Fixed
- **CRITICAL: Skill filtering was a no-op.** The `filterSkillsFromPrompt()` regex in `utils.ts` matched the Agent Skills spec format `<skill name="...">` (with the skill name as an attribute), but pi's actual `formatSkillsForPrompt()` (in `@earendil-works/pi-coding-agent/dist/core/skills.js`) emits `<skill>\n  <name>...</name>\n  <description>...</description>\n  <location>...</location>\n</skill>` (name as a child element). The regex matched **zero** of the 21 real skill blocks in this very session's system prompt — `String.prototype.replace()` returns the prompt unchanged when there are no matches, so all skills leaked through regardless of the `model-profiles.json` allowlist. The 19 unit tests for `filterSkillsFromPrompt` in `utils.test.ts` all passed because they were constructed against the wrong format. Confirmed at runtime: 21 skills in system prompt with `plan.skills = ["brainstorming","using-superpowers","writing-plans"]` → expected 3, got 21.
- **Regex updated** to match pi's actual schema: `<skill>\s*<name>([^<]+)<\/name>[\s\S]*?<\/skill>`. Same fast-paths (`["*"]`, `[]`, no `<skill>` in prompt) and same semantics — only the pattern matched against the skill blocks changed.
- **Test fixtures rewritten** in `utils.test.ts` and `index.test.ts` to use pi's actual format. Added two new tests:
  - `does NOT match the Agent Skills spec attribute format (regression guard)` — locks in that the v1.1.4 wrong format is NOT silently swallowed.
  - `matches the EXACT output of pi's formatSkillsForPrompt (integration)` — uses a verbatim copy of the schema emitted by `@earendil-works/pi-coding-agent/dist/core/skills.js` so future pi format drift is caught immediately.

### Added
- **Defensive `console.warn`** in `index.ts:before_agent_start`: if the user has a non-empty, non-`["*"]` skill filter AND the system prompt contains `<skill>` blocks AND filtering returned the prompt unchanged, log a loud warning. This is the symptom of pi changing `formatSkillsForPrompt()` without us noticing — surfaced instead of silently regressing.

### Changed
- **`utils.ts`**: doc-comment for `filterSkillsFromPrompt` updated to describe pi's actual schema (with reference to `skills.js:formatSkillsForPrompt`) instead of the Agent Skills spec attribute format.
- **`index.ts`**: `before_agent_start` now logs the defensive warning described above.

### Notes
- Total tests: **189 passing** (78 utils + 50 profiles + 61 index) — was 187 before v1.1.5.
- Manual verification on the current session: with `~/.pi/agent/model-profiles.json` `default.plan.skills = ["brainstorming","using-superpowers","writing-plans"]`, the v1.1.5 regex correctly reduces 21 → 3 `<skill>` blocks.
- This is a behavior-changing fix to a feature that was effectively missing in v1.1.4. Bumped to v1.1.5 (minor) rather than v1.1.4 patch.

[1.1.5]: https://github.com/GeorgeDong32/pi-permission-modes/compare/v1.1.4...v1.1.5

## [1.1.4] - 2026-06-29

### Added
- **Per-mode skill filtering**: Extend `~/.pi/agent/model-profiles.json` so each mode within a profile can specify a `skills` allowlist (e.g., `"skills": ["brainstorming", "writing-plans"]`). Skills not in the list are stripped from the system prompt via `before_agent_start`, saving tokens and keeping the agent focused on mode-relevant workflows.
- **`ModeConfig` type**: Profiles can now use either a string (backward compatible) or a configuration object: `{ "model": "...", "skills": [...], "tools": [...] }`.
- **`resolveModeConfig()`, `resolveSkillFilter()`, `resolveToolFilter()`** in `profiles.ts` — helpers to resolve the effective configuration for a mode, with fallback from active profile → default profile → hardcoded defaults.
- **`filterSkillsFromPrompt()`** in `utils.ts` — pure function that strips disallowed `<skill>` XML blocks from the system prompt using the Agent Skills spec format.
- **39 new tests**: 19 unit tests for config resolution, 13 unit tests for skill filtering, 7 integration tests for `before_agent_start` skill filtering.

### Changed
- **`profiles.ts`**: `ModelProfile` now accepts `string | ModeConfig` for each mode key. Added `ModeConfig` interface, `resolveModeConfig()`, `resolveSkillFilter()`, `resolveToolFilter()`, and internal `normalizeModeEntry()`.
- **`utils.ts`**: Added `filterSkillsFromPrompt()` export.
- **`index.ts`**: `before_agent_start` handler now receives `(event, ctx)`, reads the current `event.systemPrompt`, applies `filterSkillsFromPrompt()` when a non-`["*"]` skill filter is active, and returns the modified system prompt alongside the mode-context message.
- **Backward compatibility**: Existing string-only configs parse identically. No migration needed.

### Notes
- Total tests: **187 passing** (76 utils + 50 profiles + 61 index).
- Tool filtering is a **stub** in `resolveToolFilter()` (injects `read` as mandatory) — full implementation in v1.1.5.
- Skill filtering only affects system prompt injection; skills can still be invoked via `/skill:name` if needed.
- Skill filtering is config-file-only; no CLI flags for skill/tool filtering.

[1.1.4]: https://github.com/aprimediet/pi-permission-modes/compare/v1.1.3...v1.1.4

## [1.1.3] - 2026-06-29

### Added
- **Auto-mode outside-cwd write tracking**: In auto mode, `edit`/`write` calls to paths outside the working directory are now auto-approved (previously prompted), but each one is snapshotted to `<cwd>/.pi/projects/<project-id>/tmp/outside-writes/` for potential rollback. Snapshots include the pre-write file content (or `null` if the file didn't exist).
- **`/outside-writes` command**: Lists all tracked outside-cwd writes (read-only). Shows timestamp, tool, path, and what `/undo-outside-writes` would do (`would restore` vs `would delete`).
- **`/undo-outside-writes` command**: Restores one or all tracked outside-cwd writes. Modes:
  - no args — interactive selector (newest first)
  - `all` — restore all without prompting
  - `--list` (or `list`) — alias for `/outside-writes`
  - Available in all modes (not auto-only).
- **Snapshot cap at 100**: Long-running sessions auto-evict oldest snapshots (LRU) and notify via `ctx.ui.notify`.
- **21 new unit tests** in `utils.test.ts` (project ID, hash, tmp dir, snapshot lifecycle).
- **15 new integration tests** in `index.test.ts` (auto-mode tracking, undo commands, edge cases, external-modification warning).

### Changed
- **`index.ts`**: Auto-mode `tool_call` branch no longer prompts on edit/write outside cwd. Still prompts on bash destructive-outside-cwd (safety net unchanged). Tracks every outside-cwd write via `trackOutsideWrite()`. MODE_CONTEXT["auto"] updated to mention tracking. Added `formatSnapshotForDisplay()`, `isExternallyModified()`, `/outside-writes` command, and `/undo-outside-writes` command.
- **`utils.ts`**: Added 8 new exports — `OutsideWriteSnapshot`, `getProjectId`, `hashPath`, `getProjectTmpDir`, `trackOutsideWrite`, `listTrackedOutsideWrites`, `restoreOutsideWrite`, `popTrackedOutsideWrite`. Added `readFileSync`, `createHash`, `mkdirSync`, `readdirSync`, `writeFileSync`, `unlinkSync` imports. Added `MAX_TRACKED_WRITES` constant.
- **`docs/prompts/auto-mode-prompts.md`**: Updated auto-approve conditions, added write tracking section, updated decision tree.
- **`docs/PRD.md`**: Added "Outside-Cwd Write Tracking" feature and commands table.
- **`AGENTS.md`**: Updated summary, commands table, current focus, boundaries, known issues.
- **`README.md`**: Updated modes table, commands table, added outside-cwd write tracking section, bumped test count.

### Fixed
- Auto mode previously prompted on outside-cwd writes — now auto-approves (more in line with auto-mode's hands-off philosophy) while keeping a rollback safety net via snapshots.

### Notes
- Total tests: **148 passing** (60 utils + 31 profiles + 54 index integration + 3 vitest config).
- Ask/plan mode behavior unchanged.
- Bash destructive-outside-cwd prompt unchanged (still prompts).
- Snapshot dir creation failure is non-fatal: logs a warning, skips tracking, still auto-approves the write.

[1.1.3]: https://github.com/aprimediet/pi-permission-modes/compare/v1.1.2...v1.1.3

# Changelog

## [1.1.2] - 2026-06-28

### Added
- **`Alt+I` shortcut**: Cycles through model profiles defined in `~/.pi/agent/model-profiles.json`. Each press advances to the next profile (wrapping around) and re-applies the model mapping for the current mode, so the footer + status pill update immediately. Mirrors `Shift+Tab`'s cycle-by-one behavior for profiles.
- **Integration tests** — 7 new tests in `index.test.ts` for the `Alt+I` shortcut: registration, single-step advance, wrap-around from the last profile, default-profile starting point, empty-config warning, model re-application after cycling, and the "Profile activated" notification.

### Fixed
- **`applyProfileModelForMode` ignored in-memory profile switches**: `resolveModelForMode()` reads `config.active` to determine which profile to use, but `setActiveProfile()` only updated the in-memory `activeProfile` variable. After `/model-profile <name>` or `Alt+I` the wrong profile's model was applied on subsequent mode changes. Now the reload step re-stamps `active` with the in-memory `activeProfile` so profile switches always take effect. The on-disk file is NOT modified.

### Changed
- **`index.ts`**: Added `cycleProfile()` helper and `pi.registerShortcut("alt+i", ...)` registration. Hardened `applyProfileModelForMode()` to honor in-memory profile switches when reloading the config.
- **`index.test.ts`**: Fake pi stub now captures registered shortcuts in a `Map<string, Handler>` and exposes `simulateShortcut(key, ctx)` for direct invocation. (Previously a no-op stub.)
- **`package.json`**: Version bumped to `1.1.2`.
- **`README.md`**: Added `Alt+I` row to the commands/shortcuts table.

### Notes
- Total tests: **112 passing** (42 utils + 31 profiles + 39 index integration).
- `Alt+I` is a new binding — it doesn't override any built-in pi shortcut (verified against `docs/keybindings.md`).

[1.1.2]: https://github.com/aprimediet/pi-permission-modes/compare/v1.1.1...v1.1.2

## [1.1.1] - 2026-06-28

### Added
- **Per-mode model profiles**: Named profiles in `~/.pi/agent/model-profiles.json` mapping each mode (`ask` / `plan` / `auto`) to a model ID (`"provider/model"` or `"provider/model:thinking"`). When the mode changes, the extension auto-switches the model via `pi.setModel()`.
- **`/model-profile` command**: Selector (no args), direct set (`/model-profile <name>`), and list (`/model-profile list`) subcommands.
- **`--model-profile <name>` flag**: Activates a named profile on session start.
- **Thinking-level suffix**: A `":thinking"` suffix in a profile value (e.g. `"anthropic/claude-sonnet-4-5:high"`) sets the thinking level after the model switch.
- **Footer augmentation**: When a profile is active, the footer shows `profile:<name> · model/thinking` instead of plain `model/thinking`.
- **Auto-creation on missing config**: `ensureModelProfilesConfig()` is called on every `session_start` / `/reload`; if the config file is missing it's created (with the user's default model detected from `~/.pi/agent/settings.json` when available). Permissions are `0600` (user read/write only).
- **`profiles.ts`** — new pure-helper module: `loadModelProfiles`, `resolveModelForMode`, `getActiveProfileName`, `listProfiles`, `profileExists`, `parseModelId`, `ensureModelProfilesConfig`, plus mutable `setModelsPath()` for test isolation.
- **`profiles.test.ts`** — 31 new unit tests covering `parseModelId`, `resolveModelForMode`, `getActiveProfileName`, `listProfiles`, `profileExists`, `loadModelProfiles` (with tmpfile fixture), and `ensureModelProfilesConfig`.
- **Integration tests** — 9 new tests in `index.test.ts` covering: model switch on mode change, model switch on session start with `--model-profile` flag, missing-registry warning, no-API-key warning, persistence of `activeProfile`, session restore, `/model-profile list` output, `/model-profile <unknown>` notification, `/model-profile` selector.

### Changed
- **`index.ts`**: `setMode()` is now `async` and calls `applyProfileModelForMode()` after the mode change. `persistState()` now also persists `activeProfile`. `onSessionStart()` calls `ensureModelProfilesConfig()` at the top, validates `--model-profile`, restores `activeProfile` from the persisted entry, and re-applies the model at the end. `installFooter()` prepends `profile:<name> · ` to the right-side model string when a profile is active.
- **`package.json`**: Version bumped to `1.1.1`; description updated to mention per-mode model profiles.
- **`README.md`**: Added Model profiles section with example config; updated commands table with `/model-profile` and `--model-profile`; updated footer description.
- **`docs/PRD.md`**: Added per-mode model profiles as a feature; removed "Switching the AI model per mode" from non-goals (now replaced by an explicit opt-in clause); bumped version to 2.1.
- **`docs/suggestions.md`**: Added reference to `v1.1.1-suggestions.md`.
- **`AGENTS.md`**: Added `/model-profile` commands and `--model-profile` flag; updated `currentFocus` to v1.1.1; updated boundaries to clarify model-switching is opt-in via user-defined profile.

### Notes
- The model profile config file is named `model-profiles.json` (NOT `models.json`) to avoid conflict with pi's built-in `~/.pi/agent/models.json` (which is used for custom provider definitions).
- Total tests: **105 passing** (42 utils + 31 profiles + 32 index integration).

## [1.1.0] - 2026-06-28

### Added
- **3-mode redesign**: Replaced the old 4-mode system (default/plan/accept-edits/auto) with ask/plan/auto. `accept-edits` removed; `default` renamed to `ask` (backwards-compatible via `/default` alias).
- **Outside-cwd read guarding**: In ask mode, reads outside the project root now prompt for approval (matching Claude Code behavior).
- **Project-root detection**: New `findProjectRoot()` / `isInsideProject()` helpers to detect project boundaries (`.git`, `package.json`, etc.), used to relax outside-cwd prompting in auto mode when inside the project.
- **Test suite**: Initial test infrastructure with vitest — 9 utils test groups + 15 integration tests covering modes, shortcuts, commands, and edge cases.
- **Prompt documentation**: Mode-specific prompt context extracted to `docs/prompts/` (ask-mode-prompts.md, plan-mode-prompts.md, auto-mode-prompts.md).
- **Suggestions**: `docs/suggestions.md` capturing v1.2/v2.0 feature ideas.
- **Package metadata**: Added `license`, `repository`, `bugs`, `homepage`, `publishConfig` (public access), and `devDependencies` (vitest).
- **Scripts**: Added `test`, `test:watch`, `prepublishOnly`, `pack:dry` npm scripts.
- **LICENSE file**: Added MIT license.

### Changed
- **README.md**: Updated mode table, command reference, and cycle order for the new 3-mode system.
- **utils.ts**: Refactored bash allowlist and Plan: extraction helpers. Added `[DONE:n]` tracking support.
- **index.ts**: Major refactor — switched from 4-mode to 3-mode cycle, updated footer/prompt context injection, added outside-cwd guard logic.
- **"files" field**: Broadened from explicit file list to `*.ts` glob so new source files are included automatically.

### Removed
- **accept-edits mode**: Removed entirely. Equivalent behavior now provided by auto mode.
- **Inline prompt text**: Prompt content moved to separate files under `docs/prompts/` (external references).
- **Default mode**: Renamed to `ask` (with backward-compatible alias).

### Notes
- Auto-mode follow-up (auto-continue after each turn) is implemented but currently commented out — will be re-enabled when pi's auto-continue support stabilizes.

[1.1.1]: https://github.com/aprimediet/pi-permission-modes/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/aprimediet/pi-permission-modes/compare/v1.0.0...v1.1.0
