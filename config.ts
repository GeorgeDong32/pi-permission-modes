/**
 * Permission-modes extension config (`~/.pi/agent/permission-modes.json`).
 * Pure fs helpers — no pi dependency.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { AutoModeRules } from "./classifier-prompt.ts"

export type ClassifierStage = "tool" | "single" | "fast" | "both" | "thinking"

export const CLASSIFIER_STAGE_SUFFIXES: readonly ClassifierStage[] = [
	"tool",
	"single",
	"fast",
	"both",
	"thinking",
] as const

export interface ClassifierConfig {
	enabled: boolean
	model: string
	timeoutMs: number
	/** CC-style JSONL transcript lines instead of "User:" / "bash cmd" format. */
	jsonlTranscript?: boolean
	/** When true (default), classifier errors deny the action instead of local fallback. */
	failClosed?: boolean
	/** Classifier pipeline — see docs/prompts/auto-mode-prompts.md. Default `tool`. */
	stage?: ClassifierStage
	/** Inject AGENTS.md / CLAUDE.md into classifier context. */
	includeAgentsMd?: boolean
}

export interface PermissionModesConfig {
	classifier?: Partial<ClassifierConfig>
	/** CC auto-mode classifier allow / soft_deny / environment bullets. */
	autoMode?: AutoModeRules
	permissions?: {
		allow?: string[]
		deny?: string[]
		ask?: string[]
	}
}

let _configPath = join(homedir(), ".pi", "agent", "permission-modes.json")

export function getConfigPath(): string {
	return _configPath
}

export function setConfigPath(p: string): void {
	_configPath = p
}

const DEFAULT_CLASSIFIER: ClassifierConfig = {
	enabled: true,
	model: "anthropic/claude-haiku-4-5",
	timeoutMs: 15000,
	failClosed: true,
	stage: "tool",
	includeAgentsMd: true,
}

export function resolveClassifierConfig(
	config: PermissionModesConfig,
): ClassifierConfig {
	const c = config.classifier ?? {}
	return {
		enabled: c.enabled ?? DEFAULT_CLASSIFIER.enabled,
		model: c.model ?? DEFAULT_CLASSIFIER.model,
		timeoutMs: c.timeoutMs ?? DEFAULT_CLASSIFIER.timeoutMs,
		jsonlTranscript: c.jsonlTranscript ?? false,
		failClosed: c.failClosed ?? DEFAULT_CLASSIFIER.failClosed,
		stage: c.stage ?? DEFAULT_CLASSIFIER.stage,
		includeAgentsMd: c.includeAgentsMd ?? DEFAULT_CLASSIFIER.includeAgentsMd,
	}
}

export function resolveAutoModeConfig(
	config: PermissionModesConfig,
): AutoModeRules | undefined {
	const rules = config.autoMode
	if (!rules) return undefined
	if (
		!rules.allow?.length &&
		!rules.soft_deny?.length &&
		!rules.environment?.length
	) {
		return undefined
	}
	return rules
}

// (path, mtimeMs) cache (plan2 A1c): the config is read twice per turn
// (classifier + autoMode resolution) and again through the global-permissions
// loader; it changes rarely, so re-read only when the mtime moves (same
// pattern as the classifier AGENTS.md cache). Callers treat the result as
// read-only — the cached object is shared.
const configCache = new Map<string, { mtimeMs: number; config: PermissionModesConfig }>()

export function loadPermissionModesConfig(): PermissionModesConfig {
	try {
		if (!existsSync(_configPath)) return {}
		const stat = statSync(_configPath)
		const cached = configCache.get(_configPath)
		if (cached && cached.mtimeMs === stat.mtimeMs) return cached.config
		const raw = readFileSync(_configPath, "utf-8")
		if (!raw.trim()) return {}
		const config = JSON.parse(raw) as PermissionModesConfig
		configCache.set(_configPath, { mtimeMs: stat.mtimeMs, config })
		return config
	} catch (err) {
		console.warn(
			`[permission-modes] Failed to load ${_configPath}:`,
			err,
		)
		return {}
	}
}
