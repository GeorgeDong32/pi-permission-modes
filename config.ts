/**
 * Permission-modes extension config (`~/.pi/agent/permission-modes.json`).
 * Pure fs helpers — no pi dependency.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface ClassifierConfig {
	enabled: boolean
	model: string
	timeoutMs: number
}

export interface PermissionModesConfig {
	classifier?: Partial<ClassifierConfig>
}

let _configPath = join(homedir(), ".pi", "agent", "permission-modes.json")

export function getConfigPath(): string {
	return _configPath
}

export function setConfigPath(p: string): void {
	_configPath = p
}

const DEFAULT_CLASSIFIER: ClassifierConfig = {
	enabled: false,
	model: "anthropic/claude-haiku-4-5",
	timeoutMs: 8000,
}

export function resolveClassifierConfig(
	config: PermissionModesConfig,
): ClassifierConfig {
	const c = config.classifier ?? {}
	return {
		enabled: c.enabled ?? DEFAULT_CLASSIFIER.enabled,
		model: c.model ?? DEFAULT_CLASSIFIER.model,
		timeoutMs: c.timeoutMs ?? DEFAULT_CLASSIFIER.timeoutMs,
	}
}

export function loadPermissionModesConfig(): PermissionModesConfig {
	try {
		if (!existsSync(_configPath)) return {}
		const raw = readFileSync(_configPath, "utf-8")
		if (!raw.trim()) return {}
		return JSON.parse(raw) as PermissionModesConfig
	} catch (err) {
		console.warn(
			`[permission-modes] Failed to load ${_configPath}:`,
			err,
		)
		return {}
	}
}
