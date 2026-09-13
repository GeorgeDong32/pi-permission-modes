import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadPermissionModesConfig, setConfigPath } from "./config.ts"

// ---- config (path, mtime) cache (plan2 A1c) ------------------------------

describe("loadPermissionModesConfig (path, mtime) cache", () => {
	let tmp: string
	beforeEach(() => {
		tmp = join(tmpdir(), `pm-cfg-cache-${Math.random().toString(36).slice(2)}`)
		mkdirSync(tmp, { recursive: true })
	})
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true })
	})

	it("serves cached config while mtime is unchanged and re-reads when it moves", () => {
		const file = join(tmp, "permission-modes.json")
		const t1 = new Date(1_700_000_000_000)
		const t2 = new Date(1_700_000_001_000)
		setConfigPath(file)
		writeFileSync(file, JSON.stringify({ classifier: { enabled: false } }))
		utimesSync(file, t1, t1)
		expect(loadPermissionModesConfig()).toEqual({ classifier: { enabled: false } })

		// content swapped underneath but mtime forced back: cache must hit
		writeFileSync(file, JSON.stringify({ classifier: { enabled: true } }))
		utimesSync(file, t1, t1)
		expect(loadPermissionModesConfig()).toEqual({ classifier: { enabled: false } })

		// mtime moves: fresh read
		utimesSync(file, t2, t2)
		expect(loadPermissionModesConfig()).toEqual({ classifier: { enabled: true } })
	})
})
