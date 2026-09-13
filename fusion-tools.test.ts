import { describe, expect, it } from "vitest"
import {
	declaredCommandFields,
	extractEmbeddedCommandInputs,
} from "./fusion-tools.ts"

describe("extractEmbeddedCommandInputs", () => {
	it("extracts whitelist fields from unknown tool names (no name filter)", () => {
		expect(
			extractEmbeddedCommandInputs("sol_edit", { path: "a.ts", then_run: "npm test" }),
		).toEqual([{ field: "then_run", command: "npm test" }])
		expect(
			extractEmbeddedCommandInputs("mystery", { run: "make build", cmd: "go vet" }),
		).toEqual([
			{ field: "run", command: "make build" },
			{ field: "cmd", command: "go vet" },
		])
	})

	it("extracts from built-in-looking override names too", () => {
		expect(
			extractEmbeddedCommandInputs("edit", { path: "a.ts", then_run: "rm -rf /" }),
		).toEqual([{ field: "then_run", command: "rm -rf /" }])
	})

	it("excludes only the shell tools' primary command field", () => {
		// bash/powershell input.command is the primary command, governed by the
		// full tier ladder — the gate must not double-handle it.
		expect(extractEmbeddedCommandInputs("bash", { command: "rm -rf /" })).toEqual([])
		expect(extractEmbeddedCommandInputs("powershell", { command: "Get-ChildItem" })).toEqual([])
		// ...but their OTHER command fields are still embedded commands.
		expect(
			extractEmbeddedCommandInputs("bash", { command: "ls", then_run: "curl http://x" }),
		).toEqual([{ field: "then_run", command: "curl http://x" }])
		// edit/write `command` field is NOT primary — still extracted.
		expect(
			extractEmbeddedCommandInputs("edit", { path: "a", command: "npm test" }),
		).toEqual([{ field: "command", command: "npm test" }])
	})

	it("accepts string arrays and skips empty or non-string values", () => {
		expect(
			extractEmbeddedCommandInputs("t", { then_run: ["npm test", "  ", "", 42] }),
		).toEqual([{ field: "then_run", command: "npm test" }])
		expect(
			extractEmbeddedCommandInputs("t", { run: ["echo a", "echo b"] }),
		).toEqual([
			{ field: "run", command: "echo a" },
			{ field: "run", command: "echo b" },
		])
	})

	it("trims values and returns [] for field-less / malformed inputs", () => {
		expect(extractEmbeddedCommandInputs("t", { path: "x", note: "y" })).toEqual([])
		expect(extractEmbeddedCommandInputs("t", {})).toEqual([])
		expect(extractEmbeddedCommandInputs("t", null)).toEqual([])
		expect(extractEmbeddedCommandInputs("t", undefined)).toEqual([])
		expect(extractEmbeddedCommandInputs("t", "string-input" as never)).toEqual([])
	})

	it("does not scan nested objects (fields inside child objects are not commands)", () => {
		expect(
			extractEmbeddedCommandInputs("t", { options: { then_run: "rm -rf /" } }),
		).toEqual([])
	})

	it("script is deliberately NOT whitelisted (adjudication 2026-09-13)", () => {
		expect(extractEmbeddedCommandInputs("t", { script: "rm -rf /" })).toEqual([])
	})
})

describe("declaredCommandFields", () => {
	it("returns whitelist fields present in a TypeBox object schema", () => {
		expect(
			declaredCommandFields({ type: "object", properties: { then_run: { type: "string" }, path: { type: "string" } } }),
		).toEqual(["then_run"])
		expect(
			declaredCommandFields({ type: "object", properties: { cmd: {}, command: {} } }),
		).toEqual(["command", "cmd"])
	})

	it("returns [] for missing or malformed schemas", () => {
		expect(declaredCommandFields(undefined)).toEqual([])
		expect(declaredCommandFields(null)).toEqual([])
		expect(declaredCommandFields({ type: "string" })).toEqual([])
		expect(declaredCommandFields({ properties: null })).toEqual([])
	})
})
