import { describe, expect, it } from "vitest"
import {
	evaluateToolPermission,
	mergePermissionRules,
	rulesFromPermissionsConfig,
	suggestAllowRuleForToolCall,
} from "./permissions.ts"

describe("permissions evaluate", () => {
	const cwd = "/home/user/project"

	it("deny beats allow", () => {
		const rules = mergePermissionRules(
			rulesFromPermissionsConfig(
				{ allow: ["Bash(git *)"], deny: ["Bash(rm *)"] },
				"global",
			),
		)
		const verdict = evaluateToolPermission(
			"bash",
			{ command: "rm file" },
			cwd,
			rules,
		)
		expect(verdict.behavior).toBe("deny")
	})

	it("allow skips passthrough for matching bash", () => {
		const rules = rulesFromPermissionsConfig(
			{ allow: ["Bash(npm run:*)"] },
			"project",
		)
		const verdict = evaluateToolPermission(
			"bash",
			{ command: "npm run test" },
			cwd,
			rules,
		)
		expect(verdict.behavior).toBe("allow")
	})

	it("ask rule triggers ask verdict", () => {
		const rules = rulesFromPermissionsConfig(
			{ ask: ["Bash(npm install *)"] },
			"global",
		)
		const verdict = evaluateToolPermission(
			"bash",
			{ command: "npm install foo" },
			cwd,
			rules,
		)
		expect(verdict.behavior).toBe("ask")
	})

	it("suggests allow rule for tool call", () => {
		expect(
			suggestAllowRuleForToolCall(
				"bash",
				{ command: "npm test" },
				cwd,
			),
		).toBe("Bash(npm:*)")
	})

	// Characterization (plan2 C1): unknown tool names never match permission
	// rules (no CC mapping → passthrough) even when broad rules exist. The B1
	// embedded-command gate relies on this staying true.
	it("unknown tool names are passthrough regardless of rules", () => {
		const rules = rulesFromPermissionsConfig(
			{ deny: ["Bash(rm *)"], allow: ["Edit(src/**)"] },
			"global",
		)
		expect(
			evaluateToolPermission("sol_fusion", { path: "src/a.ts" }, cwd, rules),
		).toEqual({ behavior: "passthrough" })
		expect(
			evaluateToolPermission("mystery", {}, cwd, rules),
		).toEqual({ behavior: "passthrough" })
	})

	// plan2 B1: powershell maps onto Bash rules (pi 0.85.1 built-in shell).
	it("powershell evaluates under Bash permission rules", () => {
		const rules = rulesFromPermissionsConfig(
			{ deny: ["Bash(rm *)"], allow: ["Bash(npm *)"] },
			"global",
		)
		expect(
			evaluateToolPermission("powershell", { command: "rm -rf x" }, cwd, rules).behavior,
		).toBe("deny")
		expect(
			evaluateToolPermission("powershell", { command: "npm test" }, cwd, rules).behavior,
		).toBe("allow")
	})
})
