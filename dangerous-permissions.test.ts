import { describe, expect, it } from "vitest"

import {
	formatDangerousRuleDisplay,
	isDangerousBashPermission,
	restoreDangerousPermissionRules,
	stripDangerousPermissionRules,
} from "./dangerous-permissions.ts"
import { permissionRuleValueFromString } from "./permission-rule-parser.ts"
import type { PermissionRule } from "./permissions.ts"

function allowRule(
	ruleString: string,
	source: PermissionRule["source"] = "project",
): PermissionRule {
	return {
		source,
		behavior: "allow",
		ruleValue: permissionRuleValueFromString(ruleString),
	}
}

describe("dangerous-permissions", () => {
	it("flags Bash(*) and interpreter prefixes as dangerous", () => {
		expect(isDangerousBashPermission("Bash", undefined)).toBe(true)
		expect(isDangerousBashPermission("Bash", "*")).toBe(true)
		expect(isDangerousBashPermission("Bash", "python:*")).toBe(true)
		expect(isDangerousBashPermission("Bash", "npm run:*")).toBe(true)
		expect(isDangerousBashPermission("Bash", "curl:*")).toBe(true)
	})

	it("does not flag specific safe-ish allow patterns", () => {
		expect(isDangerousBashPermission("Bash", "npm install *")).toBe(false)
		expect(isDangerousBashPermission("Bash", "npm run test *")).toBe(false)
	})

	it("strips dangerous allow rules on auto entry and restores on exit", () => {
		const rules = [
			allowRule("Bash(npm install *)"),
			allowRule("Bash(python:*)"),
			allowRule("Bash(*)"),
		]
		const stripped = stripDangerousPermissionRules(rules)
		expect(stripped.active).toHaveLength(1)
		expect(formatDangerousRuleDisplay(stripped.stashed[0]!.ruleValue)).toBe(
			"Bash(python:*)",
		)
		expect(stripped.stashed).toHaveLength(2)
		const restored = restoreDangerousPermissionRules(
			stripped.active,
			stripped.stashed,
		)
		expect(restored).toHaveLength(3)
	})
})
