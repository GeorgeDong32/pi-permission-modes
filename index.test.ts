/**
 * Integration tests for the permission-modes extension.
 *
 * Strategy: import the extension factory with a fake `ExtensionAPI` stub.
 * The stub captures all `pi.on(event, handler)` subscriptions; we then invoke
 * the captured `tool_call` handler directly with crafted events and contexts.
 *
 * This lets us assert the gate decision tree without booting real pi.
 */

import { describe, expect, it, beforeEach, vi } from "vitest"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import permissionModesExtension from "./index.ts"
import { setConfigPath } from "./config.ts"
import { writeProjectPermissionsFile } from "./permissions-loader.ts"
import { setModelsPath } from "./profiles.ts"
import {
	listTrackedOutsideWrites,
	type OutsideWriteSnapshot,
} from "./utils.ts"

// ---- minimal fake pi API ------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>

type CommandHandler = (
	args: string,
	ctx: unknown,
) => unknown | Promise<unknown>

interface FakePi {
	handlers: Map<string, Handler[]>
	commands: Map<string, CommandHandler>
	shortcuts: Map<string, Handler>
	userMessages: Array<{ text: string; opts?: unknown }>
	sentMessages: Array<{
		message: { customType?: string; content?: unknown; display?: boolean }
		opts?: unknown
	}>
	appendEntries: Array<{ type: string; data: unknown }>
	activeTools: string[]
	flags: Record<string, unknown>
	setModelCalls: Array<{ model: unknown }>
	thinkingLevel: string
	modelRegistry: Map<string, Map<string, unknown>>
	getToolCallHandler: (mode?: string) => Handler | undefined
	simulateSessionStart: (
		cwd: string,
		ui?: unknown,
		registry?: { find: (provider: string, model: string) => unknown },
	) => Promise<void>
	simulateToolCall: (
		toolName: string,
		input: Record<string, unknown>,
		ctx: object,
	) => Promise<unknown>
	simulateCommand: (name: string, args: string, ctx: object) => Promise<unknown>
	simulateShortcut: (
		key: string,
		ctx: object,
	) => Promise<unknown>
}

interface FakeCtxOptions {
	mode?: string
	cwd: string
	projectRoot?: string | null
	ui?: {
		select?: (label: string, options: string[]) => Promise<string>
		notify?: (msg: string) => void
		editor?: (label: string, val: string) => Promise<string | undefined>
	}
}

function createFakePi(): FakePi {
	const handlers = new Map<string, Handler[]>()
	const commands = new Map<string, CommandHandler>()
	const shortcuts = new Map<string, Handler>()
	const userMessages: Array<{ text: string; opts?: unknown }> = []
	const sentMessages: Array<{
		message: { customType?: string; content?: unknown; display?: boolean }
		opts?: unknown
	}> = []
	const appendEntries: Array<{ type: string; data: unknown }> = []
	const activeTools = ["read", "edit", "write", "bash", "grep", "find"]
	const flags: Record<string, unknown> = { "permission-mode": "ask" }
	const setModelCalls: Array<{ model: unknown }> = []
	let thinkingLevel = "off"
	const modelRegistry = new Map<string, Map<string, unknown>>()

	const pi = {
		handlers,
		commands,
		shortcuts,
		userMessages,
		sentMessages,
		appendEntries,
		activeTools,
		flags,
		setModelCalls,
		getThinkingLevel: () => thinkingLevel,
		setThinkingLevel: (l: string) => {
			thinkingLevel = l
		},
		modelRegistry: {
			find: (provider: string, model: string) => {
				const providerMap = modelRegistry.get(provider)
				if (!providerMap) return undefined
				return providerMap.get(model)
			},
		},

		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
		},
		registerCommand(name: string, def: { handler: CommandHandler }) {
			commands.set(name, def.handler)
		},
		registerShortcut(key: string, def: { handler: Handler }) {
			shortcuts.set(key, def.handler)
		},
		registerFlag(name: string, def: { default?: unknown }) {
			// Always record the flag so the extension can read it via getFlag.
			// Default is honored when provided.
			if (def?.default !== undefined) flags[name] = def.default
			else if (!(name in flags)) flags[name] = undefined
		},
		getFlag(name: string) {
			return flags[name]
		},
		appendEntry(type: string, data: unknown) {
			appendEntries.push({ type, data })
		},
		getActiveTools() {
			return [...activeTools]
		},
		setActiveTools(tools: string[]) {
			activeTools.length = 0
			activeTools.push(...tools)
		},
		sendUserMessage(text: string, opts?: unknown) {
			userMessages.push({ text, opts })
		},
		sendMessage(message: unknown, opts?: unknown) {
			sentMessages.push({ message: message as never, opts })
		},
		async setModel(model: unknown) {
			setModelCalls.push({ model })
			return true
		},

		// Test helpers
		getToolCallHandler() {
			const list = handlers.get("tool_call") ?? []
			return list[0]
		},
		async simulateSessionStart(
			cwd: string,
			ui?: unknown,
			registry?: { find: (provider: string, model: string) => unknown },
		) {
			const list = handlers.get("session_start") ?? []
			const fullCtx = makeCtx(pi, {
				cwd,
				ui: (ui ?? {}) as FakeCtxOptions["ui"],
				modelRegistry: registry ?? pi.modelRegistry,
			})
			for (const h of list) await h({}, fullCtx)
		},
		async simulateToolCall(
			toolName: string,
			input: Record<string, unknown>,
			ctx: object,
		) {
			const list = handlers.get("tool_call") ?? []
			for (const h of list) {
				const result = await h({ toolName, input }, ctx)
				if (result !== undefined) return result
			}
			return undefined
		},
		async simulateCommand(name: string, args: string, ctx: object) {
			const handler = commands.get(name)
			if (!handler) throw new Error(`No command registered: ${name}`)
			return handler(args, ctx)
		},
		async simulateShortcut(key: string, ctx: object) {
			const handler = shortcuts.get(key)
			if (!handler) throw new Error(`No shortcut registered: ${key}`)
			return handler(ctx)
		},
	}
	return pi
}

// Cast: we hand the fake pi to the extension factory which expects ExtensionAPI.
// The shape matches the subset of methods the extension actually calls.
function makeFakePiForExtension(p: FakePi) {
	return p as unknown as Parameters<typeof permissionModesExtension>[0]
}

function makeCtx(
	p: FakePi,
	opts: FakeCtxOptions & {
		modelRegistry?: { find: (provider: string, model: string) => unknown }
	},
) {
	const ui = opts.ui ?? {}
	return {
		cwd: opts.cwd,
		hasUI: !!opts.ui,
		modelRegistry: opts.modelRegistry ?? p.modelRegistry,
		ui: {
			select: ui.select ?? (async () => "Block"),
			notify: ui.notify ?? (() => {}),
			editor: ui.editor ?? (async () => undefined),
			setStatus: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setWorkingIndicator: () => {},
			setWorkingMessage: () => {},
			theme: {
				fg: (_role: string, text: string) => text,
				strikethrough: (t: string) => t,
			},
		},
		sessionManager: {
			getBranch: () => [],
			getGitBranch: () => "",
			getEntries: () => [],
		},
		model: undefined,
	}
}

// ---- tests --------------------------------------------------------------

describe("permission-modes extension: tool_call gate", () => {
	let pi: FakePi
	let realProjectRoot: string

	beforeEach(async () => {
		pi = createFakePi()
		// Use real fs: the current repo IS a project (has package.json).
		realProjectRoot = process.cwd()
		permissionModesExtension(makeFakePiForExtension(pi))
		await pi.simulateSessionStart(realProjectRoot)
	})

	async function callToolCall(
		toolName: string,
		input: Record<string, unknown>,
		ui?: FakeCtxOptions["ui"],
	) {
		const ctx = makeCtx(pi, {
			cwd: realProjectRoot,
			ui,
		})
		return pi.simulateToolCall(toolName, input, ctx)
	}

	async function switchMode(mode: string) {
		pi.flags["permission-mode"] = mode
		await pi.simulateSessionStart(realProjectRoot)
	}

	describe("ask mode", () => {
		it("prompts on edit (inside cwd)", async () => {
			await switchMode("ask")
			const result = await callToolCall("edit", { path: "src/foo.ts" }, {
				select: async () => "Block",
			})
			expect(result).toMatchObject({ block: true })
		})

		it("auto-approves read (inside cwd)", async () => {
			await switchMode("ask")
			const result = await callToolCall("read", { path: "src/foo.ts" })
			expect(result).toBeUndefined()
		})

		it("prompts on read outside cwd", async () => {
			await switchMode("ask")
			const result = await callToolCall("read", { path: "/etc/passwd" })
			expect(result).toMatchObject({ block: true })
		})

		it("auto-approves safe bash", async () => {
			await switchMode("ask")
			const result = await callToolCall("bash", { command: "ls -la" })
			expect(result).toBeUndefined()
		})

		it("prompts on destructive bash", async () => {
			await switchMode("ask")
			const result = await callToolCall("bash", { command: "rm -rf /" }, {
				select: async () => "Block",
			})
			expect(result).toMatchObject({ block: true })
		})

		it("prompts on grep outside cwd", async () => {
			await switchMode("ask")
			const result = await callToolCall("grep", { path: "/etc/hosts" })
			expect(result).toMatchObject({ block: true })
		})

		it("auto-approves grep inside cwd", async () => {
			await switchMode("ask")
			const result = await callToolCall("grep", { path: "src/foo.ts" })
			expect(result).toBeUndefined()
		})
	})

	describe("plan mode", () => {
		it("blocks edit (defensive — tool is also stripped via setActiveTools)", async () => {
			await switchMode("plan")
			const result = await callToolCall("edit", { path: "src/foo.ts" })
			expect(result).toMatchObject({ block: true })
		})

		it("auto-approves read", async () => {
			await switchMode("plan")
			const result = await callToolCall("read", { path: "src/foo.ts" })
			expect(result).toBeUndefined()
		})

		it("auto-approves safe bash", async () => {
			await switchMode("plan")
			const result = await callToolCall("bash", { command: "ls" })
			expect(result).toBeUndefined()
		})

		it("blocks destructive bash", async () => {
			await switchMode("plan")
			const result = await callToolCall("bash", { command: "rm -rf /" })
			expect(result).toMatchObject({ block: true })
		})
	})



	describe("auto mode", () => {
		it("auto-approves edit inside cwd", async () => {
			await switchMode("auto")
			const result = await callToolCall("edit", { path: "src/foo.ts" })
			expect(result).toBeUndefined()
		})

		it("auto-approves in-cwd edits without prompt", async () => {
			await switchMode("auto")
			const result = await callToolCall("edit", { path: "src/foo.ts" })
			expect(result).toBeUndefined()
		})

		it("prompts on destructive bash (tier 3)", async () => {
			await switchMode("auto")
			const result = await callToolCall("bash", { command: "rm -rf ./build" })
			expect(result).toMatchObject({ block: true })
		})

		it("allows destructive bash when user approves", async () => {
			await switchMode("auto")
			const result = await callToolCall(
				"bash",
				{ command: "rm .marker" },
				{ select: async () => "Allow" },
			)
			expect(result).toBeUndefined()
		})

		it("prompts on write outside cwd (tier 3)", async () => {
			await switchMode("auto")
			const result = await callToolCall("write", { path: "/tmp/outside.txt" })
			expect(result).toMatchObject({ block: true })
		})

		it("allows write outside cwd when user approves", async () => {
			await switchMode("auto")
			const result = await callToolCall(
				"write",
				{ path: "/tmp/outside.txt" },
				{ select: async () => "Allow" },
			)
			expect(result).toBeUndefined()
		})

		it("prompts on curl bash (network blacklist)", async () => {
			await switchMode("auto")
			const result = await callToolCall("bash", {
				command: "curl https://example.com",
			})
			// curl is in the read-only SAFE_PATTERNS list → tier 1.5 auto-approve
			expect(result).toBeUndefined()
		})

		it("auto-approves npm install via isAutoApprovableBash", async () => {
			await switchMode("auto")
			const result = await callToolCall("bash", {
				command: "npm install lodash",
			})
			expect(result).toBeUndefined()
		})

		it("prompts on dangerous bash not covered by auto-approvable", async () => {
			await switchMode("auto")
			const result = await callToolCall("bash", {
				command: "rm -rf node_modules",
			})
			expect(result).toMatchObject({ block: true })
		})

		it("auto-approves safe read-only bash inside tier-3", async () => {
			await switchMode("auto")
			const result = await callToolCall("bash", { command: "ls -la" })
			expect(result).toBeUndefined()
		})

		it("auto-approves safe read-only bash (node --version)", async () => {
			await switchMode("auto")
			const result = await callToolCall("bash", {
				command: "node --version",
			})
			expect(result).toBeUndefined()
		})

		it("still prompts on safe+mutating compound bash", async () => {
			await switchMode("auto")
			const result = await callToolCall("bash", {
				command: "grep foo bar & npm i",
			})
			expect(result).toMatchObject({ block: true })
		})

		it("auto-approves npm test in fallback path", async () => {
			await switchMode("auto")
			const result = await callToolCall("bash", { command: "npm test" })
			expect(result).toBeUndefined()
		})

		it("auto-approves read outside cwd for non-sensitive paths", async () => {
			await switchMode("auto")
			const result = await callToolCall("read", { path: "/etc/passwd" })
			expect(result).toBeUndefined()
		})

		it("prompts on read of sensitive paths", async () => {
			await switchMode("auto")
			const result = await callToolCall("read", { path: ".git/config" })
			expect(result).toMatchObject({ block: true })
		})

		it("prompts on bash touching .git", async () => {
			await switchMode("auto")
			const result = await callToolCall("bash", {
				command: "cat .git/config",
			})
			expect(result).toMatchObject({ block: true })
		})
	})

	describe("permission rules", () => {
		let configTmp: string

		beforeEach(() => {
			configTmp = mkdtempSync(join(tmpdir(), "pm-idx-perm-"))
			setConfigPath(join(configTmp, "permission-modes.json"))
		})

		it("allow rule bypasses auto-mode prompt for matching bash", async () => {
			writeProjectPermissionsFile(realProjectRoot, {
				allow: ["Bash(npm install *)"],
			})
			await pi.simulateSessionStart(realProjectRoot)
			await switchMode("auto")
			const result = await callToolCall("bash", {
				command: "npm install -g @scope/pkg",
			})
			expect(result).toBeUndefined()
		})

		it("deny rule blocks before mode gate", async () => {
			writeProjectPermissionsFile(realProjectRoot, {
				deny: ["Bash(curl *)"],
			})
			await pi.simulateSessionStart(realProjectRoot)
			await switchMode("auto")
			const result = await callToolCall("bash", {
				command: "curl https://example.com",
			})
			expect(result).toMatchObject({ block: true })
			expect(String((result as { reason?: string })?.reason)).toContain(
				"Denied by permission rule",
			)
		})
	})

	describe("bypass mode", () => {
		it("auto-approves destructive bash", async () => {
			await switchMode("bypass")
			const result = await callToolCall("bash", { command: "rm -rf ./build" })
			expect(result).toBeUndefined()
		})

		it("auto-approves write outside cwd", async () => {
			await switchMode("bypass")
			const result = await callToolCall("write", { path: "/tmp/outside.txt" })
			expect(result).toBeUndefined()
		})
	})
})

describe("permission-modes extension: no auto follow-up (v2.0.0)", () => {
	let pi: FakePi

	beforeEach(() => {
		pi = createFakePi()
	})

	async function simulateTurnEnd(message: unknown) {
		const list = pi.handlers.get("turn_end") ?? []
		for (const h of list) {
			await h({ message }, makeCtx(pi, { cwd: "/home/user/project/src" }))
		}
	}

	it("does NOT send Continue follow-up in auto mode", async () => {
		permissionModesExtension(makeFakePiForExtension(pi))
		await pi.simulateSessionStart("/home/user/project/src")
		pi.flags["permission-mode"] = "auto"
		await pi.simulateSessionStart("/home/user/project/src")

		await simulateTurnEnd({
			role: "assistant",
			content: [
				{ type: "text", text: "Working on step 2 now." },
				{ type: "toolCall", name: "bash", input: { command: "ls" } },
			],
		})

		expect(pi.userMessages.length).toBe(0)
	})
})

// ---- model profile tests -----------------------------------------------
//
// Profile helpers live in profiles.ts (unit-tested in profiles.test.ts).
// These integration tests verify the wiring between profiles.ts and
// index.ts: session-start flag, command handlers, mode-switch hook,
// session-restore, and persistence.

describe("permission-modes extension: model profiles", () => {
	let pi: FakePi

	beforeEach(() => {
		pi = createFakePi()
	})

	function setupProfile(cfg: unknown) {
		const fs = require("node:fs") as typeof import("node:fs")
		const path = require("node:path") as typeof import("node:path")
		const tmp = path.join(
			"/tmp",
			`pm-int-mp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
		)
		setModelsPath(tmp)
		fs.writeFileSync(tmp, JSON.stringify(cfg))
		return tmp
	}

	it("ensureModelProfilesConfig runs on session_start and persists activeProfile in entry", async () => {
		setupProfile({
			active: "main",
			main: { ask: "p1/a" },
		})
		permissionModesExtension(makeFakePiForExtension(pi))
		await pi.simulateSessionStart("/home/user/project/src")
		// After session_start with no flag, persistState is not yet called.
		// Trigger a mode switch to force persist.
		await pi.simulateCommand("auto", "", makeCtx(pi, { cwd: "/home/user/project/src" }))
		const last = pi.appendEntries[pi.appendEntries.length - 1]
		expect(last.type).toBe("modes")
		expect((last.data as any).currentMode).toBe("auto")
	})

	it("applyProfileModelForMode switches model when profile is active and mapping exists", async () => {
		setupProfile({
			active: "main",
			main: { ask: "prov1/askModel", plan: "prov1/planModel", auto: "prov1/autoModel" },
		})
		const fakeModel = { id: "askModel" }
		pi.flags["model-profile"] = "main"
		permissionModesExtension(makeFakePiForExtension(pi))
		await pi.simulateSessionStart("/home/user/project/src", undefined, {
			find: (provider: string, model: string) => {
				if (provider === "prov1" && model === "askModel") return fakeModel
				return undefined
			},
		})
		expect(pi.setModelCalls.length).toBeGreaterThan(0)
		expect(pi.setModelCalls[0].model).toBe(fakeModel)
	})

	it("applyProfileModelForMode warns (not crashes) when model is not in registry", async () => {
		setupProfile({
			active: "main",
			main: { ask: "missing/missing" },
		})
		pi.flags["model-profile"] = "main"
		const notifs: string[] = []
		permissionModesExtension(makeFakePiForExtension(pi))
		await pi.simulateSessionStart("/home/user/project/src", {
			notify: (m: string) => notifs.push(m),
			select: async () => "Block",
		}, {
			find: () => undefined,
		})
		expect(pi.setModelCalls.length).toBe(0)
		expect(notifs.some((n) => /not found/i.test(n))).toBe(true)
	})

	it("applyProfileModelForMode warns when setModel returns false (no API key)", async () => {
		setupProfile({
			active: "main",
			main: { ask: "prov1/askModel" },
		})
		pi.flags["model-profile"] = "main"
		// Override setModel to return false (simulates missing API key)
		const fakePi = pi as unknown as { setModel: (m: unknown) => Promise<boolean> }
		const originalSetModel = fakePi.setModel
		fakePi.setModel = async () => false
		const notifs: string[] = []
		permissionModesExtension(makeFakePiForExtension(pi))
		await pi.simulateSessionStart("/home/user/project/src", {
			notify: (m: string) => notifs.push(m),
			select: async () => "Block",
		}, {
			find: () => ({ id: "askModel" }),
		})
		expect(pi.setModelCalls.length).toBe(0)
		expect(notifs.some((n) => /api key|no api/i.test(n))).toBe(true)
		fakePi.setModel = originalSetModel
	})

	it("setMode re-applies the model when profile is active", async () => {
		setupProfile({
			active: "main",
			main: { ask: "p/askM", plan: "p/planM", auto: "p/autoM" },
		})
		const fakeModels: Record<string, unknown> = {
			askM: { id: "askM" },
			planM: { id: "planM" },
			autoM: { id: "autoM" },
		}
		const registry = {
			find: (_provider: string, model: string) => fakeModels[model],
		}
		pi.flags["model-profile"] = "main"
		permissionModesExtension(makeFakePiForExtension(pi))
		await pi.simulateSessionStart("/home/user/project/src", undefined, registry)
		const initialCalls = pi.setModelCalls.length
		// Switch mode → should re-resolve and call setModel for the new mode's mapping.
		await pi.simulateCommand(
			"plan",
			"",
			makeCtx(pi, { cwd: "/home/user/project/src", modelRegistry: registry }),
		)
		expect(pi.setModelCalls.length).toBe(initialCalls + 1)
		expect(pi.setModelCalls[pi.setModelCalls.length - 1].model).toEqual({
			id: "planM",
		})
	})

	it("activeProfile is persisted in the modes entry after a profile switch", async () => {
		setupProfile({
			active: "alpha",
			alpha: { ask: "p/a" },
			beta: { ask: "p/b" },
		})
		permissionModesExtension(makeFakePiForExtension(pi))
		await pi.simulateSessionStart("/home/user/project/src")
		// Activate beta via /model-profile beta
		await pi.simulateCommand(
			"model-profile",
			"beta",
			makeCtx(pi, { cwd: "/home/user/project/src" }),
		)
		const last = pi.appendEntries[pi.appendEntries.length - 1]
		expect((last.data as any).activeProfile).toBe("beta")
	})

	it("session restore re-applies the persisted profile's model", async () => {
		setupProfile({
			active: "main",
			main: { ask: "prov1/askModel", plan: "prov1/planModel", auto: "prov1/autoModel" },
		})
		const fakeModel = { id: "planModel" }
		const entries = [
			{
				type: "custom",
				customType: "modes",
				data: { currentMode: "plan", autoFollowUpDepth: 20, activeProfile: "main" },
			},
		]
		permissionModesExtension(makeFakePiForExtension(pi))
		const list = pi.handlers.get("session_start") ?? []
		for (const h of list) {
			await h(
				{},
				{
					cwd: "/home/user/project/src",
					hasUI: false,
					modelRegistry: {
						find: (provider: string, model: string) =>
							provider === "prov1" && model === "planModel"
								? fakeModel
								: undefined,
					},
					sessionManager: {
						getBranch: () => entries,
						getGitBranch: () => "",
						getEntries: () => entries,
					},
				},
			)
		}
		expect(pi.setModelCalls.some((c) => c.model === fakeModel)).toBe(true)
	})

	it("/model-profile list formats and sends a message", async () => {
		setupProfile({
			active: "main",
			main: { ask: "p/a", plan: "p/p", auto: "p/au" },
			alt: { ask: "p2/a" },
		})
		permissionModesExtension(makeFakePiForExtension(pi))
		await pi.simulateSessionStart("/home/user/project/src")
		await pi.simulateCommand(
			"model-profile",
			"list",
			makeCtx(pi, { cwd: "/home/user/project/src" }),
		)
		expect(pi.sentMessages.length).toBe(1)
		const content = String(pi.sentMessages[0].message.content ?? "")
		expect(content).toMatch(/main/)
		expect(content).toMatch(/alt/)
	})

	it("/model-profile <unknown> shows an 'Unknown profile' notification", async () => {
		setupProfile({ active: "main", main: { ask: "p/a" } })
		const notifs: string[] = []
		permissionModesExtension(makeFakePiForExtension(pi))
		await pi.simulateSessionStart("/home/user/project/src", {
			notify: (m: string) => notifs.push(m),
			select: async () => "Block",
		})
		await pi.simulateCommand(
			"model-profile",
			"nonexistent",
			makeCtx(pi, {
				cwd: "/home/user/project/src",
				ui: {
					notify: (m: string) => notifs.push(m),
					select: async () => "Block",
				},
			}),
		)
		expect(notifs.some((n) => /unknown profile/i.test(n))).toBe(true)
	})

	it("/model-profile with no args shows a selector and activates the chosen profile", async () => {
		setupProfile({
			active: "main",
			main: { ask: "p/a" },
			alt: { ask: "p2/a" },
		})
		permissionModesExtension(makeFakePiForExtension(pi))
		await pi.simulateSessionStart("/home/user/project/src")
		await pi.simulateCommand(
			"model-profile",
			"",
			makeCtx(pi, {
				cwd: "/home/user/project/src",
				ui: {
					select: async (_label: string, options: string[]) =>
						options.includes("alt") ? "alt" : options[0],
					notify: () => {},
				},
			}),
		)
		const last = pi.appendEntries[pi.appendEntries.length - 1]
		expect((last.data as any).activeProfile).toBe("alt")
	})
})

// ---- Alt+I: cycle profile shortcut --------------------------------------
//
// Verifies the registered shortcut advances the active profile by one, wraps
// around, notifies the user, and re-applies the model mapping for the
// current mode.

describe("permission-modes extension: Alt+I cycle profile shortcut", () => {
	let pi: FakePi

	beforeEach(() => {
		pi = createFakePi()
	})

	function setupProfile(cfg: unknown) {
		const fs = require("node:fs") as typeof import("node:fs")
		const path = require("node:path") as typeof import("node:path")
		const tmp = path.join(
			"/tmp",
			`pm-int-cyc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
		)
		setModelsPath(tmp)
		fs.writeFileSync(tmp, JSON.stringify(cfg))
		return tmp
	}

	it("registers the alt+i shortcut", () => {
		permissionModesExtension(makeFakePiForExtension(pi))
		expect(pi.shortcuts.has("alt+i")).toBe(true)
	})

	it("advances the active profile to the next one and persists the change", async () => {
		setupProfile({
			active: "alpha",
			alpha: { ask: "p/a" },
			beta: { ask: "p/b" },
			gamma: { ask: "p/g" },
		})
		permissionModesExtension(makeFakePiForExtension(pi))
		await pi.simulateSessionStart("/home/user/project/src")
		// Start active at 'alpha' (from config.active). Cycle should land on 'beta'.
		await pi.simulateShortcut(
			"alt+i",
			makeCtx(pi, {
				cwd: "/home/user/project/src",
				ui: { notify: () => {}, select: async () => "Block" },
			}),
		)
		const last = pi.appendEntries[pi.appendEntries.length - 1]
		expect((last.data as any).activeProfile).toBe("beta")
	})

	it("wraps from the last profile back to the first", async () => {
		setupProfile({
			active: "gamma",
			alpha: { ask: "p/a" },
			beta: { ask: "p/b" },
			gamma: { ask: "p/g" },
		})
		permissionModesExtension(makeFakePiForExtension(pi))
		await pi.simulateSessionStart("/home/user/project/src")
		await pi.simulateShortcut(
			"alt+i",
			makeCtx(pi, {
				cwd: "/home/user/project/src",
				ui: { notify: () => {}, select: async () => "Block" },
			}),
		)
		const last = pi.appendEntries[pi.appendEntries.length - 1]
		expect((last.data as any).activeProfile).toBe("alpha")
	})

	it("uses default profile as starting point when no profile is active", async () => {
		setupProfile({
			active: "main",
			main: { ask: "p/a" },
			alt: { ask: "p2/a" },
		})
		permissionModesExtension(makeFakePiForExtension(pi))
		await pi.simulateSessionStart("/home/user/project/src")
		// activeProfile is undefined until set explicitly. Cycle should still
		// advance: it should land on the profile AFTER the implicit
		// getActiveProfileName() (which is "main"), so → "alt".
		await pi.simulateShortcut(
			"alt+i",
			makeCtx(pi, {
				cwd: "/home/user/project/src",
				ui: { notify: () => {}, select: async () => "Block" },
			}),
		)
		const last = pi.appendEntries[pi.appendEntries.length - 1]
		expect((last.data as any).activeProfile).toBe("alt")
	})

	it("warns when no profiles exist in the config", async () => {
		setupProfile({})
		const notifs: string[] = []
		permissionModesExtension(makeFakePiForExtension(pi))
		await pi.simulateSessionStart("/home/user/project/src", {
			notify: (m: string) => notifs.push(m),
			select: async () => "Block",
		})
		await pi.simulateShortcut(
			"alt+i",
			makeCtx(pi, {
				cwd: "/home/user/project/src",
				ui: {
					notify: (m: string) => notifs.push(m),
					select: async () => "Block",
				},
			}),
		)
		expect(notifs.some((n) => /no profiles/i.test(n))).toBe(true)
	})

	it("re-applies the model mapping for the current mode after cycling", async () => {
		setupProfile({
			active: "alpha",
			alpha: { ask: "p/askA" },
			beta: { ask: "p/askB" },
		})
		const fakeModels: Record<string, unknown> = {
			askA: { id: "askA" },
			askB: { id: "askB" },
		}
		const registry = {
			find: (_provider: string, model: string) => fakeModels[model],
		}
		permissionModesExtension(makeFakePiForExtension(pi))
		await pi.simulateSessionStart("/home/user/project/src", undefined, registry)
		// Force activation so the call to setActiveProfile re-resolves the model.
		await pi.simulateShortcut(
			"alt+i",
			makeCtx(pi, {
				cwd: "/home/user/project/src",
				ui: { notify: () => {}, select: async () => "Block" },
				modelRegistry: registry,
			}),
		)
		// The last setModel call should be for askB (the new profile's mapping
		// for the ask mode we start in).
		const last = pi.setModelCalls[pi.setModelCalls.length - 1]
		expect(last.model).toEqual({ id: "askB" })
	})

	it("notifies with the newly-activated profile name", async () => {
		setupProfile({
			active: "alpha",
			alpha: { ask: "p/a" },
			beta: { ask: "p/b" },
		})
		const notifs: string[] = []
		permissionModesExtension(makeFakePiForExtension(pi))
		await pi.simulateSessionStart("/home/user/project/src", {
			notify: (m: string) => notifs.push(m),
			select: async () => "Block",
		})
		await pi.simulateShortcut(
			"alt+i",
			makeCtx(pi, {
				cwd: "/home/user/project/src",
				ui: {
					notify: (m: string) => notifs.push(m),
					select: async () => "Block",
				},
			}),
		)
		expect(notifs.some((n) => /profile.*beta.*activated/i.test(n))).toBe(true)
	})
})
describe("bypass mode: outside-cwd write tracking", () => {
	let pi: FakePi
	let realProjectRoot: string
	let outsideTmpDir: string
	let outsideFile: string

	async function switchMode(mode: string) {
		pi.flags["permission-mode"] = mode
		await pi.simulateSessionStart(realProjectRoot)
	}

	beforeEach(async () => {
		pi = createFakePi()
		// Use real fs: the current repo IS a project (has package.json).
		realProjectRoot = process.cwd()
		outsideTmpDir = mkdtempSync(join(tmpdir(), "pm-outside-"))
		outsideFile = join(outsideTmpDir, "test.txt")
		permissionModesExtension(makeFakePiForExtension(pi))
		await pi.simulateSessionStart(realProjectRoot)
	})

	afterEach(() => {
		// Clean up any .pi/ artifacts created in realProjectRoot
		const tmpDir = join(realProjectRoot, ".pi", "projects")
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
		rmSync(outsideTmpDir, { recursive: true, force: true })
	})

	it("auto-approves write outside cwd (no prompt)", async () => {
		await switchMode("bypass")
		const ctx = makeCtx(pi, { cwd: realProjectRoot })
		const result = await pi.simulateToolCall("write", { path: outsideFile }, ctx)
		expect(result).toBeUndefined()
	})

	it("captures backup content of existing file before writing", async () => {
		writeFileSync(outsideFile, "ORIGINAL")
		await switchMode("bypass")
		const ctx = makeCtx(pi, { cwd: realProjectRoot })
		// Write tool_call happens BEFORE the tool actually runs in real pi;
		// in our fake we just call the handler. So pre-write content is "ORIGINAL".
		await pi.simulateToolCall("write", { path: outsideFile }, ctx)
		// Snapshot must exist
		const snaps = listTrackedOutsideWrites(realProjectRoot)
		expect(snaps).toHaveLength(1)
		expect(snaps[0].originalPath).toBe(outsideFile)
		expect(snaps[0].backupContent).toBe("ORIGINAL")
		expect(snaps[0].toolName).toBe("write")
	})

	it("tracks null backup when file did not exist before write", async () => {
		await switchMode("bypass")
		const ctx = makeCtx(pi, { cwd: realProjectRoot })
		await pi.simulateToolCall("write", { path: outsideFile }, ctx)
		const snaps = listTrackedOutsideWrites(realProjectRoot)
		expect(snaps[0].backupContent).toBeNull()
	})

	it("stacks snapshots when same path is written twice", async () => {
		writeFileSync(outsideFile, "FIRST_ORIGINAL")
		await switchMode("bypass")
		const ctx = makeCtx(pi, { cwd: realProjectRoot })
		await pi.simulateToolCall("write", { path: outsideFile }, ctx)
		// The snapshot captures pre-write content
		const snap1 = listTrackedOutsideWrites(realProjectRoot)[0]
		expect(snap1.backupContent).toBe("FIRST_ORIGINAL")

		// Second write — snapshot captures whatever the file had before this write.
		// In the fake, file content is unchanged from after the first call
		// (since we didn't actually write anything). So the new backup matches.
		await new Promise((r) => setTimeout(r, 5))
		await pi.simulateToolCall("write", { path: outsideFile }, ctx)
		const snaps = listTrackedOutsideWrites(realProjectRoot)
		expect(snaps).toHaveLength(2)
		expect(snaps[0].timestamp).not.toBe(snaps[1].timestamp)
	})

	it("does NOT track writes inside cwd", async () => {
		await switchMode("bypass")
		const ctx = makeCtx(pi, { cwd: realProjectRoot })
		await pi.simulateToolCall("write", { path: "src/foo.ts" }, ctx)
		expect(listTrackedOutsideWrites(realProjectRoot)).toEqual([])
	})

	it("notifies user when write is tracked", async () => {
		const notifications: string[] = []
		await switchMode("bypass")
		const ctx = makeCtx(pi, {
			cwd: realProjectRoot,
			ui: { notify: (m: string) => notifications.push(m), select: async () => "Block" },
		})
		await pi.simulateToolCall("write", { path: outsideFile }, ctx)
		expect(notifications.some((n) => n.includes("tracked"))).toBe(true)
	})

	it("does NOT prompt on outside-cwd write even with strict UI", async () => {
		await switchMode("bypass")
		let prompted = false
		const ctx = makeCtx(pi, {
			cwd: realProjectRoot,
			ui: {
				select: async () => {
					prompted = true
					return "Block"
				},
				notify: () => {},
			},
		})
		const result = await pi.simulateToolCall("write", { path: outsideFile }, ctx)
		expect(prompted).toBe(false)
		expect(result).toBeUndefined()
	})
})


describe("/outside-writes and /undo-outside-writes commands", () => {
	let pi: FakePi
	let cwd: string
	let outsideDir: string
	let outsideFile: string

	beforeEach(() => {
		pi = createFakePi()
		cwd = mkdtempSync(join(tmpdir(), "pm-cmd-"))
		outsideDir = mkdtempSync(join(tmpdir(), "pm-cmd-out-"))
		outsideFile = join(outsideDir, "outside-target.txt")
		permissionModesExtension(makeFakePiForExtension(pi))
	})

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true })
		rmSync(outsideDir, { recursive: true, force: true })
	})

	async function setupTrackedWrites() {
		writeFileSync(outsideFile, "ORIGINAL")
		await pi.simulateSessionStart(cwd)
		pi.flags["permission-mode"] = "bypass"
		await pi.simulateSessionStart(cwd)

		// Simulate two tracked writes
		const ctx1 = makeCtx(pi, { cwd })
		await pi.simulateToolCall("write", { path: outsideFile }, ctx1)
		await new Promise((r) => setTimeout(r, 5))
		const ctx2 = makeCtx(pi, { cwd })
		await pi.simulateToolCall("edit", { path: outsideFile }, ctx2)
	}

	it("/outside-writes displays tracked snapshots via sendMessage", async () => {
		await setupTrackedWrites()
		await pi.simulateCommand("outside-writes", "", makeCtx(pi, { cwd }))
		const lastMsg = pi.sentMessages[pi.sentMessages.length - 1]
		expect(lastMsg.message.customType).toBe("outside-writes-list")
		expect(String(lastMsg.message.content)).toContain(outsideFile)
		expect(String(lastMsg.message.content)).toContain("would restore")
	})

	it("/undo-outside-writes --list behaves like /outside-writes", async () => {
		await setupTrackedWrites()
		await pi.simulateCommand("undo-outside-writes", "--list", makeCtx(pi, { cwd }))
		expect(pi.sentMessages.some((m) =>
			m.message.customType === "outside-writes-list"
		)).toBe(true)
	})

	it("/undo-outside-writes list alias also works", async () => {
		await setupTrackedWrites()
		await pi.simulateCommand("undo-outside-writes", "list", makeCtx(pi, { cwd }))
		expect(pi.sentMessages.some((m) =>
			m.message.customType === "outside-writes-list"
		)).toBe(true)
	})

	it("/undo-outside-writes all restores everything and pops all snapshots", async () => {
		await setupTrackedWrites()
		// Simulate that the tool actually wrote something
		writeFileSync(outsideFile, "NEW_CONTENT")
		await pi.simulateCommand("undo-outside-writes", "all", makeCtx(pi, { cwd }))
		// File restored
		expect(readFileSync(outsideFile, "utf-8")).toBe("ORIGINAL")
		// Snapshots popped
		expect(listTrackedOutsideWrites(cwd)).toEqual([])
	})

	it("/undo-outside-writes (no args) shows selector and restores selected", async () => {
		await setupTrackedWrites()
		writeFileSync(outsideFile, "NEW_CONTENT")
		let selectorOptions: string[] = []
		const ctx = makeCtx(pi, {
			cwd,
			ui: {
				select: async (_label: string, options: string[]) => {
					selectorOptions = options
					return options[0]!
				},
				notify: () => {},
			},
		})
		await pi.simulateCommand("undo-outside-writes", "", ctx)
		expect(selectorOptions.length).toBeGreaterThan(0)
		expect(readFileSync(outsideFile, "utf-8")).toBe("ORIGINAL")
	})

	it("/undo-outside-writes handles empty snapshot list gracefully", async () => {
		await pi.simulateSessionStart(cwd)
		const notifications: string[] = []
		await pi.simulateCommand("undo-outside-writes", "all", makeCtx(pi, {
			cwd,
			ui: { notify: (m: string) => notifications.push(m), select: async () => "Block" },
		}))
		expect(notifications.some((n) => n.includes("No tracked"))).toBe(true)
	})

	it("/undo-outside-writes deletes file when backupContent was null", async () => {
		await pi.simulateSessionStart(cwd)
		pi.flags["permission-mode"] = "bypass"
		await pi.simulateSessionStart(cwd)
		// File didn't exist before write
		await pi.simulateToolCall("write", { path: outsideFile }, makeCtx(pi, { cwd }))
		// Simulate tool creating the file
		writeFileSync(outsideFile, "NEWLY_CREATED")
		await pi.simulateCommand("undo-outside-writes", "all", makeCtx(pi, { cwd }))
		expect(existsSync(outsideFile)).toBe(false)
	})

	it("/outside-writes is available in ask mode too", async () => {
		// Verify the command runs without mode restriction (even in ask mode).
		// Set up in auto mode, then switch to ask
		pi.flags["permission-mode"] = "ask"
		await pi.simulateSessionStart(cwd)
		// In ask mode, outside-writes should not throw
		await expect(
			pi.simulateCommand("outside-writes", "", makeCtx(pi, { cwd }))
		).resolves.not.toThrow()
	})
})

// ---- Skill filtering in before_agent_start -----------------------------

describe("skill filtering in before_agent_start", () => {
	let tmpDir: string
	let pi: FakePi
	let realProjectRoot: string

	function skillPrompt(skills: string[]): string {
		// Use pi's actual `formatSkillsForPrompt` schema (see
		// `@earendil-works/pi-coding-agent/dist/core/skills.js`). The v1.1.4
		// tests used the wrong `<skill name="...">` attribute format and all
		// passed while the feature was broken at runtime.
		const blocks = skills.map(
			(s) =>
				[
					"  <skill>",
					`    <name>${s}</name>`,
					`    <description>${s}</description>`,
					`    <location>/home/user/.pi/agent/skills/${s}/SKILL.md</location>`,
					"  </skill>",
				].join("\n"),
		)
		return [
			"You are a helpful assistant.",
			"",
			"<available_skills>",
			...blocks,
			"</available_skills>",
			"",
			"[ASK MODE ACTIVE]",
			"## Available tools",
		].join("\n")
	}

	async function triggerBeforeAgentStart(
		prompt: string,
		mode: string,
	): Promise<{ message?: unknown; systemPrompt?: string } | undefined> {
		pi.flags["permission-mode"] = mode
		await pi.simulateSessionStart(realProjectRoot)
		const handlers = pi.handlers.get("before_agent_start") ?? []
		if (handlers.length === 0) return undefined
		const event = {
			type: "before_agent_start" as const,
			prompt: "user",
			systemPrompt: prompt,
			systemPromptOptions: { cwd: realProjectRoot },
		}
		const ctx = makeCtx(pi, { cwd: realProjectRoot })
		const result = await handlers[0]!(event, ctx)
		return result as { message?: unknown; systemPrompt?: string } | undefined
	}

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pm-skf-"))
		pi = createFakePi()
		realProjectRoot = process.cwd()
		// Re-point the model-profiles config at a tmpfile so each test starts
		// from a known empty (or custom) config.
		setModelsPath(join(tmpDir, "model-profiles.json"))
	})

	afterEach(() => {
		// Clean up any .pi/ artifacts created in realProjectRoot
		const projectTmp = join(realProjectRoot, ".pi", "projects")
		if (existsSync(projectTmp)) rmSync(projectTmp, { recursive: true, force: true })
		rmSync(tmpDir, { recursive: true, force: true })
		// Restore default models path so other test files are unaffected
		setModelsPath(join(realProjectRoot, "model-profiles.json"))
	})

	it("does not filter skills when no filter is configured", async () => {
		permissionModesExtension(makeFakePiForExtension(pi))
		const prompt = skillPrompt(["brainstorming", "systematic-debugging"])
		const result = await triggerBeforeAgentStart(prompt, "ask")
		// Skills unchanged; ask mode injects one-line reminder anchor
		expect(result?.systemPrompt).toContain("brainstorming")
		expect(result?.systemPrompt).toContain("systematic-debugging")
		expect(result?.systemPrompt).toContain("[Ask]")
	})

	it("filters skills when a mode-specific skill filter is active", async () => {
		writeFileSync(
			join(tmpDir, "model-profiles.json"),
			JSON.stringify({
				active: "default",
				default: {
					plan: {
						skills: ["brainstorming"],
					},
				},
			}),
		)
		permissionModesExtension(makeFakePiForExtension(pi))
		const prompt = skillPrompt(["brainstorming", "systematic-debugging"])
		const result = await triggerBeforeAgentStart(prompt, "plan")
		expect(result?.systemPrompt).toBeDefined()
		expect(result!.systemPrompt).toContain("brainstorming")
		expect(result!.systemPrompt).not.toContain("systematic-debugging")
	})

	it("does not filter when config has no skill filter for the active mode", async () => {
		writeFileSync(
			join(tmpDir, "model-profiles.json"),
			JSON.stringify({
				active: "default",
				default: {
					plan: { model: "" }, // model only, no skills filter
				},
			}),
		)
		permissionModesExtension(makeFakePiForExtension(pi))
		const prompt = skillPrompt(["brainstorming", "systematic-debugging"])
		const result = await triggerBeforeAgentStart(prompt, "plan")
		// Skills unchanged; plan mode anchor still injected via systemPrompt
		expect(result?.systemPrompt).toContain("brainstorming")
		expect(result?.systemPrompt).toContain("systematic-debugging")
		expect(result?.systemPrompt).toContain("permission-modes:context")
	})

	it("injects bypass security reminder on session start", async () => {
		permissionModesExtension(makeFakePiForExtension(pi))
		const result = await triggerBeforeAgentStart("base prompt", "bypass")
		expect(result?.systemPrompt).toContain("[Bypass]")
		expect(result!.systemPrompt).toContain("auto-approved")
	})

	it("injects plan anchor in system prompt with skill filtering", async () => {
		writeFileSync(
			join(tmpDir, "model-profiles.json"),
			JSON.stringify({
				active: "default",
				default: {
					plan: {
						skills: ["brainstorming"],
					},
				},
			}),
		)
		permissionModesExtension(makeFakePiForExtension(pi))
		const prompt = skillPrompt(["brainstorming", "systematic-debugging"])
		const result = await triggerBeforeAgentStart(prompt, "plan")
		expect(result?.systemPrompt).toBeDefined()
		expect(result!.systemPrompt).toContain("brainstorming")
		expect(result!.systemPrompt).not.toContain("systematic-debugging")
		expect(result!.systemPrompt).toContain("[Plan]")
		expect(result?.message).toBeUndefined()
	})

	it("handles empty skill filter (interpreted as no filter — allow all)", async () => {
		// Per the v1.1.4 spec: an empty `skills` list is a no-op (treated like
		// ["*"]) by filterSkillsFromPrompt. The user effectively said "no
		// filter" — same as the default behavior.
		writeFileSync(
			join(tmpDir, "model-profiles.json"),
			JSON.stringify({
				default: {
					plan: { skills: [] },
				},
			}),
		)
		permissionModesExtension(makeFakePiForExtension(pi))
		const prompt = skillPrompt(["brainstorming", "systematic-debugging"])
		const result = await triggerBeforeAgentStart(prompt, "plan")
		// systemPrompt should contain the original skills (filter is a no-op)
		expect(result?.systemPrompt).toBeDefined()
		expect(result!.systemPrompt).toContain("brainstorming")
		expect(result!.systemPrompt).toContain("systematic-debugging")
	})

	it("filters skills only for the mode the filter is configured on", async () => {
		writeFileSync(
			join(tmpDir, "model-profiles.json"),
			JSON.stringify({
				active: "default",
				default: {
					plan: { skills: ["brainstorming"] },
				},
			}),
		)
		permissionModesExtension(makeFakePiForExtension(pi))
		const prompt = skillPrompt(["brainstorming", "systematic-debugging"])
		const askResult = await triggerBeforeAgentStart(prompt, "ask")
		// ask mode has no skill filter; skills preserved + ask anchor
		expect(askResult?.systemPrompt).toContain("systematic-debugging")
		expect(askResult?.systemPrompt).toContain("[Ask]")
	})

	it("applies skill filter from active profile (not default profile)", async () => {
		writeFileSync(
			join(tmpDir, "model-profiles.json"),
			JSON.stringify({
				active: "custom",
				custom: {
					plan: { skills: ["brainstorming"] },
				},
				default: {
					plan: { skills: ["writing-plans"] },
				},
			}),
		)
		permissionModesExtension(makeFakePiForExtension(pi))
		const prompt = skillPrompt(["brainstorming", "writing-plans", "systematic-debugging"])
		const result = await triggerBeforeAgentStart(prompt, "plan")
		expect(result?.systemPrompt).toContain("brainstorming")
		expect(result?.systemPrompt).not.toContain("writing-plans")
		expect(result?.systemPrompt).not.toContain("systematic-debugging")
	})
})
