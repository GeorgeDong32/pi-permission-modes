/**
 * Dangerous allow-rule detection for auto mode (CC permissionSetup.ts subset).
 * Broad Bash allow rules bypass the classifier and are stripped on auto entry.
 */

import {
	permissionRuleValueToString,
	type PermissionRuleValue,
} from "./permission-rule-parser.ts"
import type { PermissionRule } from "./permissions.ts"

/** Cross-platform code-execution entry points (shared with CC dangerousPatterns.ts). */
export const CROSS_PLATFORM_CODE_EXEC = [
	"python",
	"python3",
	"python2",
	"node",
	"deno",
	"tsx",
	"ruby",
	"perl",
	"php",
	"lua",
	"npx",
	"bunx",
	"npm run",
	"yarn run",
	"pnpm run",
	"bun run",
	"bash",
	"sh",
	"ssh",
] as const

export const DANGEROUS_BASH_PATTERNS: readonly string[] = [
	...CROSS_PLATFORM_CODE_EXEC,
	"zsh",
	"fish",
	"eval",
	"exec",
	"env",
	"xargs",
	"sudo",
	"curl",
	"wget",
	"git",
]

export function isDangerousBashPermission(
	toolName: string,
	ruleContent: string | undefined,
): boolean {
	if (toolName !== "Bash") return false
	if (ruleContent === undefined || ruleContent === "") return true

	const content = ruleContent.trim().toLowerCase()
	if (content === "*") return true

	for (const pattern of DANGEROUS_BASH_PATTERNS) {
		const lowerPattern = pattern.toLowerCase()
		if (content === lowerPattern) return true
		if (content === `${lowerPattern}:*`) return true
		if (content === `${lowerPattern}*`) return true
		if (content === `${lowerPattern} *`) return true
		if (content.startsWith(`${lowerPattern} -`) && content.endsWith("*")) {
			return true
		}
	}

	return false
}

export function isDangerousClassifierPermission(
	toolName: string,
	ruleContent: string | undefined,
): boolean {
	return isDangerousBashPermission(toolName, ruleContent)
}

export type StripDangerousResult = {
	active: PermissionRule[]
	stashed: PermissionRule[]
}

function ruleKey(rule: PermissionRule): string {
	return `${rule.behavior}:${permissionRuleValueToString(rule.ruleValue)}:${rule.source}`
}

/** Remove dangerous allow rules from the active set; stash them for restore on auto exit. */
export function stripDangerousPermissionRules(
	rules: PermissionRule[],
): StripDangerousResult {
	const stashed: PermissionRule[] = []
	const active: PermissionRule[] = []

	for (const rule of rules) {
		if (
			rule.behavior === "allow" &&
			isDangerousClassifierPermission(
				rule.ruleValue.toolName,
				rule.ruleValue.ruleContent,
			)
		) {
			stashed.push(rule)
		} else {
			active.push(rule)
		}
	}

	return { active, stashed }
}

export function restoreDangerousPermissionRules(
	active: PermissionRule[],
	stashed: PermissionRule[],
): PermissionRule[] {
	if (!stashed.length) return active
	const seen = new Set(active.map(ruleKey))
	const merged = [...active]
	for (const rule of stashed) {
		const key = ruleKey(rule)
		if (seen.has(key)) continue
		seen.add(key)
		merged.push(rule)
	}
	return merged
}

export function formatDangerousRuleDisplay(
	ruleValue: PermissionRuleValue,
): string {
	if (ruleValue.ruleContent === undefined) {
		return `${ruleValue.toolName}(*)`
	}
	return `${ruleValue.toolName}(${ruleValue.ruleContent})`
}
