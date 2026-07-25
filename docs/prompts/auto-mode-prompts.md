# Auto Mode — Prompt Reference

> **v2.2.0 (CC-aligned).** Tiered auto-approve with optional classifier, deny-and-continue on classifier blocks, and fail-closed when classifier is unavailable.

---

## 1. Mode metadata

```typescript
// MODE_META["auto"]
{ icon: "▶", label: "Auto", role: "warning" }
```

- **Slash commands:** `/auto`
- **Cycle position:** `ask → plan → auto → bypass → ask`
- **Flag:** `--permission-mode auto`

---

## 2. System context injection

Injected via `before_agent_start` anchor (`<!-- permission-modes:context -->`).

Auto mode also injects a **tool-output injection warning** (CC-aligned) and escalates when recent tool results match heuristic injection patterns.

---

## 3. Tiered auto-approve (v2.2.0)

| Tier | What auto-approves | Examples |
|------|-------------------|----------|
| **0** | Permission `allow` rules (dangerous broad rules stripped on auto entry) | `Bash(npm install *)` |
| **1** | Read-only bash (`isSafeCommand`) | `ls`, `cat`, `git status`, `npm list` |
| **1.5** | `autoMode.allow` patterns (all segments must pass tier-2 check) | user-configured |
| **2** | Cwd内 `edit`/`write`; `isAutoApprovableBash` | `npm test`, `npm run build`, `git commit` |
| **3** | Classifier + local risk fallback | `curl`, `npm install`, outside-cwd writes, unknown tools |

**Removed from tier-1/2 (v2.2.0):** `curl`, `wget`, `npm install`, `git fetch/pull`, arbitrary `node`/`python`, `docker pull`.

---

## 4. Classifier behavior (v2.2.0)

| Event | Behavior |
|-------|----------|
| Classifier **allows** | Auto-approve; reset consecutive denial counter |
| Classifier **blocks** | **Deny-and-continue** — `{ block: true, reason: buildYoloRejectionMessage(...) }` (no approval UI) |
| Classifier **unavailable** (3 retries) | **Fail-closed** by default (`classifier.failClosed: true`) |
| 3 consecutive / 20 total classifier blocks | Escalate to **manual approval UI** |
| Sensitive path / `soft_deny` / permission `ask` | Always **manual approval UI** |

---

## 5. Decision tree (tool_call gate)

```
if currentMode === "auto":
  apply permission rules (dangerous allows stripped)
  if read/grep/find/ls:
    sensitive path → prompt UI
    else → allow
  if edit/write:
    sensitive path → prompt UI
    cwd内 → allow
    outside cwd → tier-3 (classifier)
  if bash:
    sensitive ref → prompt UI
    isSafeCommand → allow (tier-1)
    autoMode.allow + isAutoApprovableBash → allow (tier-1.5)
    autoMode.soft_deny → prompt UI
    isAutoApprovableBash → allow (tier-2)
    else → approveAutoTier3 (classifier / local / prompt)
```

---

## 6. Config (`~/.pi/agent/permission-modes.json`)

```json
{
  "classifier": {
    "enabled": true,
    "model": "anthropic/claude-haiku-4-5",
    "timeoutMs": 20000,
    "model": "CPA/Minimax/MiniMax-M2.7@tool",
    "timeoutMs": 20000,
    "failClosed": true,
    "stage": "tool",
    "includeAgentsMd": true
  },
  "autoMode": {
    "allow": [],
    "soft_deny": [],
    "environment": []
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `classifier.failClosed` | `true` | Deny when classifier errors (iron gate) |
| `classifier.stage` | `tool` | `tool` (forced `classify_result`, no API thinking) / `single` (JSON) / `fast` / `both` / `thinking` (XML pipelines) |
| `classifier.model` suffix | — | `provider/model@tool` overrides `classifier.stage` for that model |
| `classifier.includeAgentsMd` | `true` | Include AGENTS.md in classifier context |

---

## 7. Related code

| What | File |
|------|------|
| Tier gate | `index.ts` `tool_call` auto branch |
| Classifier client | `classifier-client.ts` |
| Dangerous allow strip | `dangerous-permissions.ts` |
| Denial tracking | `denial-tracking.ts` |
| Deny messages | `classifier-messages.ts` |
| Injection probe | `injection-probe.ts` |
| Safe / approvable patterns | `utils.ts` |
