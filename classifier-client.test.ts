import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	buildClassifierUserPrompt,
	classifyToolCall,
	parseClassifierVerdict,
	parseModelRef,
	redactForClassifier,
} from "./classifier-client.ts"
import type { ClassifierRegistry } from "./classifier-providers/types.ts"

describe("parseModelRef", () => {
	it("parses provider/model", () => {
		expect(parseModelRef("anthropic/claude-haiku-4-5")).toEqual({
			provider: "anthropic",
			modelId: "claude-haiku-4-5",
		})
	})

	it("rejects invalid refs", () => {
		expect(parseModelRef("nope")).toBeNull()
	})
})

describe("parseClassifierVerdict", () => {
	it("parses raw JSON", () => {
		expect(parseClassifierVerdict('{"allow":false,"reason":"risky"}')).toEqual({
			allow: false,
			reason: "risky",
		})
	})

	it("parses fenced JSON", () => {
		expect(
			parseClassifierVerdict('```json\n{"allow":true,"reason":"ok"}\n```'),
		).toEqual({ allow: true, reason: "ok" })
	})

	it("returns null on bad JSON", () => {
		expect(parseClassifierVerdict("not json")).toBeNull()
	})
})

describe("classifyToolCall", () => {
	const originalFetch = globalThis.fetch

	beforeEach(() => {
		vi.restoreAllMocks()
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	function makeRegistry(api: string): ClassifierRegistry {
		return {
			find: () => ({
				id: "test-model",
				api,
				baseUrl: "https://api.example.com",
				provider: "test",
			}),
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "test-key",
			}),
		}
	}

	it("calls anthropic messages API", async () => {
		globalThis.fetch = vi.fn(async () =>
			Response.json({
				content: [{ type: "text", text: '{"allow":true,"reason":"fine"}' }],
			}),
		) as typeof fetch

		const verdict = await classifyToolCall({
			modelRef: "test/test-model",
			userMessages: ["fix the bug"],
			pendingTool: { name: "read", input: { path: "a.ts" } },
			registry: makeRegistry("anthropic-messages"),
			timeoutMs: 5000,
		})
		expect(verdict.allow).toBe(true)
		const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, RequestInit]
		expect(url).toContain("/v1/messages")
		expect(init.method).toBe("POST")
	})

	it("calls openai chat completions API", async () => {
		globalThis.fetch = vi.fn(async () =>
			Response.json({
				choices: [{ message: { content: '{"allow":false,"reason":"no"}' } }],
			}),
		) as typeof fetch

		const verdict = await classifyToolCall({
			modelRef: "test/test-model",
			userMessages: [],
			pendingTool: { name: "bash", input: { command: "rm -rf /" } },
			registry: makeRegistry("openai-completions"),
			timeoutMs: 5000,
		})
		expect(verdict.allow).toBe(false)
		const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string]
		expect(url).toContain("/v1/chat/completions")
	})

	it("throws on unsupported api", async () => {
		await expect(
			classifyToolCall({
				modelRef: "test/test-model",
				userMessages: [],
				pendingTool: { name: "bash", input: {} },
				registry: makeRegistry("bedrock-converse-stream"),
				timeoutMs: 1000,
			}),
		).rejects.toThrow(/Unsupported classifier api/)
	})
})

describe("buildClassifierUserPrompt", () => {
	it("includes tool call JSON", () => {
		const prompt = buildClassifierUserPrompt(["hello"], {
			name: "write",
			input: { path: "x" },
		})
		expect(prompt).toContain("hello")
		expect(prompt).toContain('"write"')
	})

	it("redacts secrets", () => {
		const prompt = buildClassifierUserPrompt(
			["token sk-abcdefghijklmnopqrstuvwxyz"],
			{ name: "bash", input: { command: "echo" } },
		)
		expect(prompt).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
		expect(prompt).toContain("sk-[REDACTED]")
	})
})

describe("redactForClassifier", () => {
	it("redacts bearer tokens", () => {
		expect(redactForClassifier("Bearer abc.def.ghi")).toContain(
			"Bearer [REDACTED]",
		)
	})
})
