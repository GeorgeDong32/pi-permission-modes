# AGENTS.md — permission-modes

Guide for coding agents working in this repository. Product context (goals, users,
features, success metrics): see [docs/PRD.md](docs/PRD.md).

## Summary
A pi extension that implements Claude-Code-style permission modes (ask / plan / auto) for the pi coding agent, published on npm as `@georgedong32/permission-modes@1.1.5`. It intercepts tool calls, gates approvals per mode, injects mode-specific context, provides a live footer + status pill, guards reads outside cwd in ask mode, supports auto-mode follow-up bounded by `/auto-depth`, auto-switches the model per mode when the user has defined profiles in `~/.pi/agent/model-profiles.json`, tracks outside-cwd writes for undo (v1.1.3+), and (v1.1.4+) supports per-mode skill filtering to keep the system prompt lean and mode-relevant.

## Tech Stack
- **Language:** TypeScript (ESM — `"type": "module"`)
- **Framework:** Pi coding agent extension API (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`)
- **Package Manager:** npm (no lock file committed)
- **Peer Dependencies:** `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox`
- **Third-party deps:** None

## Project Structure
```
permission-modes/             # @georgedong32/permission-modes
├── package.json              # pi manifest + npm package metadata
├── index.ts                  # main extension — default-exported factory function
├── profiles.ts               # model-profile config helpers (load, resolve, parse)
├── profiles.test.ts          # unit tests for profiles.ts (vitest)
├── utils.ts                  # pure helpers: bash allowlist, Plan: extraction, [DONE:n] tracking
├── index.test.ts             # integration tests (vitest)
├── utils.test.ts             # unit tests for utils (vitest)
├── vitest.config.ts          # vitest configuration
├── CHANGELOG.md              # release history
├── LICENSE                   # MIT
├── .gitignore                # excludes node_modules, package-lock.json, .pi/ artifacts
├── docs/
│   ├── PRD.md                # product requirements (human audience)
│   ├── prompts/              # mode-specific prompt context
│   │   ├── ask-mode-prompts.md
│   │   ├── plan-mode-prompts.md
│   │   └── auto-mode-prompts.md
│   └── suggestions.md        # feature ideas for future versions
├── AGENTS.md                 # this file
├── CLAUDE.md                 # thin pointer → AGENTS.md
└── .pi/
    └── permission-modes-45ea0551.md  # pi project marker (auto-generated)
```

## Commands

### Pi runtime (inside pi after extension loaded)

| Action | Command |
|---|---|
| Switch mode | `/ask`, `/plan`, `/auto`, or `/mode` (`/default` works as alias) |
| Set auto depth | `/auto-depth <n>` (0 = unlimited; default 20) |
| Switch model profile | `/model-profile` (selector) or `/model-profile <name>`; `/model-profile list` to print all |
| Undo outside-cwd writes | `/undo-outside-writes` (selector, `all`, or `--list`) |
| List outside-cwd writes | `/outside-writes` |
| Shortcut | `Shift+Tab` to cycle modes |
| Shortcut | `Alt+T` to cycle thinking level |
| Shortcut | `Alt+I` to cycle through model profiles |
| Start flag | `pi --permission-mode <name>` |
| Start flag | `pi --model-profile <name>` (activates a named profile) |
| Load in dev | `pi -e ./extensions/permission-modes/index.ts` |
| Hot-reload | `/reload` (after edits) |
| Verify loaded | `pi list` |

### Standalone (npm scripts)

| Action | Command |
|---|---|
| Run tests | `npm test` |
| Watch tests | `npm run test:watch` |
| Dry-run package | `npm run pack:dry` |
| Publish | `npm publish` |

## Conventions
- **Style:** TypeScript, ESM (`import`/`export`), no semicolons (standard pi extension style)
- **Naming:** `camelCase` for variables/functions, `PascalCase` for types, `SCREAMING_SNAKE` for constants
- **Extension pattern:** Default-export a function receiving `pi: ExtensionAPI`, register hooks on `pi.on(...)` events
- **State management:** Plain module-scoped variables; persist via `pi.appendEntry("modes", ...)` with restore in `session_start` / `session_tree`
- **UI:** Use `ctx.hasUI` gating — never assume a UI exists
- **Types:** Use `type` from the pi-core packages; no external type deps

## Boundaries (technical)
- **Do NOT** add third-party runtime dependencies — peer deps only (pi-core + typebox)
- **Do NOT** change pi's core behavior — only intercept tool calls via `pi.on("tool_call", ...)` and return `{ block: true, reason }` or `undefined`
- **Do NOT** modify the model outside an explicit user-defined profile — `pi.setModel()` is only called when the user has opted in via `~/.pi/agent/model-profiles.json` (i.e. `activeProfile !== undefined`). When no profile is active, the extension works exactly as v1.1.0.
- **Do NOT** block auto-mode edit/write outside cwd — the v1.1.3 design auto-approves them and tracks snapshots for undo. The destructive-bash-outside-cwd prompt is the only auto-mode prompt that remains.
- **Do NOT** filter skills via skill discovery or resource events — use `filterSkillsFromPrompt()` in `before_agent_start` to strip disallowed skill XML blocks from the system prompt string.
- **Do NOT** implement tool filtering in v1.1.4 — `resolveToolFilter()` is a stub that only ensures `read` is mandatory. Full tool configurable filtering is v1.1.5.
- **Do NOT** duplicate content between AGENTS.md and CLAUDE.md — keep AGENTS.md as the single source of truth
- **Safe to delete:** `.pi/permission-modes-45ea0551.md` (recreated automatically)
- **Invariants:** The three-mode cycle (ask → plan → auto) is hard-coded in `MODE_CYCLE`; accept-edits was removed and default was renamed to ask in v2.0.0. The plan-mode tool restrictions (`PLAN_TOOLS`, `PLAN_DISABLED`) and bash safe/destructive patterns are in `utils.ts`. The model-profile config file path is `~/.pi/agent/model-profiles.json` (NOT `models.json`, which is reserved for pi's custom provider definitions). Change these with care.

## Known Issues & Gotchas
- **Test infrastructure exists** — 187+ tests across `index.test.ts`, `profiles.test.ts`, and `utils.test.ts` using vitest. Always run `npm test` before committing non-trivial changes.
- **Snapshot cap at 100:** Long-running sessions in auto mode that touch >100 outside-cwd paths will LRU-evict oldest snapshots. The user gets a notification on eviction. This is intentional — prevents unbounded tmp dir growth.
- The `--permission-mode` flag uses a distinct name because pi has a built-in `--mode` flag for output format (text/json/rpc). Do not rename it to `--mode`.
- Auto mode follow-up logic is currently enabled in `index.ts` (the `turn_end` handler block); failures are caught with `console.warn` so a missing followUp support in older pi versions degrades gracefully.
- `typebox` is listed as a peer dep but not currently imported. It may be needed for future input validation.
- **Model profile config path is `~/.pi/agent/model-profiles.json`**, NOT `models.json`. Pi uses the latter for custom provider definitions; using a different name avoids format conflict.
- The `modelsPath` export is mutable via `setModelsPath(p)` to allow tests to redirect to a tmpdir fixture. Don't rely on assignment to the exported binding directly (ESM forbids it).
- No `.env` / `.env.example` — this extension has no environment secrets.
- No `tsconfig.json` — pi bundles its own TypeScript configuration.
- **Registry indexing lag:** `npm view` can return stale data for a few minutes after publish. Verify via direct GET to `https://registry.npmjs.org/@georgedong32/permission-modes/<version>`.
- **No git tags yet:** tag the release on GitHub with `git tag v<version> && git push origin v<version>`.

## Companion Extensions
- **minion (@aprimediet/minion):** Active (project `permission-modes-45ea0551`, 0 open tasks). Check the kanban board at `~/.pi/projects/permission-modes-45ea0551/tasks/` before starting work to see if any delegated tasks are pending.
- **memory (@aprimediet/memory):** Active (8+ entries). Durable facts are stored at `~/.pi/projects/permission-modes-45ea0551/memory/`. Use `memory_write` to save decisions/gotchas and `memory_search` to recall context.

## Current Focus
- **v1.1.4** released — config schema extended, skill filtering in before_agent_start, 187 tests
- **v1.1.5** next — tool filtering, /mode-config command, interactive selectors
- See [CHANGELOG.md](CHANGELOG.md) for full release history
