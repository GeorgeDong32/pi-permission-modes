import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	buildClassifierUserPrompt,
	classifyToolCall,
	parseClassifierVerdict,
	parseModelRef,
	redactForClassifier,
	type ClassifierRegistry,
} from "./classifier-client.ts"

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}))

vi.mock("@earendil-works/pi-ai/compat", () => ({
	completeSimple: completeSimpleMock,
}))

function makeAssistantResponse(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	}
}

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
	beforeEach(() => {
		completeSimpleMock.mockReset()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	function makeRegistry(): ClassifierRegistry {
		return {
			find: () =>
				({
					id: "test-model",
					api: "anthropic-messages",
					baseUrl: "https://api.example.com",
					provider: "test",
				}) as any,
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "test-key",
			}),
		}
	}

	it("calls completeSimple with classifier context and auth", async () => {
		completeSimpleMock.mockResolvedValue(
			makeAssistantResponse('{"allow":true,"reason":"fine"}'),
		)

		const verdict = await classifyToolCall({
			modelRef: "test/test-model",
			userMessages: ["fix the bug"],
			pendingTool: { name: "read", input: { path: "a.ts" } },
			registry: makeRegistry(),
			timeoutMs: 5000,
		})

		expect(verdict.allow).toBe(true)
		expect(completeSimpleMock).toHaveBeenCalledTimes(1)
		const [model, context, options] = completeSimpleMock.mock.calls[0]!
		expect(model.provider).toBe("test")
		expect(context.systemPrompt).toContain("security classifier")
		expect(context.messages[0]?.content[0]).toEqual({
			type: "text",
			text: expect.stringContaining("fix the bug"),
		})
		expect(options).toMatchObject({
			apiKey: "test-key",
			maxTokens: 256,
			temperature: 0,
			timeoutMs: 5000,
		})
	})

	it("returns deny verdict from classifier output", async () => {
		completeSimpleMock.mockResolvedValue(
			makeAssistantResponse('{"allow":false,"reason":"no"}'),
		)

		const verdict = await classifyToolCall({
			modelRef: "test/test-model",
			userMessages: [],
			pendingTool: { name: "bash", input: { command: "rm -rf /" } },
			registry: makeRegistry(),
			timeoutMs: 5000,
		})
		expect(verdict.allow).toBe(false)
	})

	it("passes registry headers and env through to completeSimple", async () => {
		completeSimpleMock.mockResolvedValue(
			makeAssistantResponse('{"allow":true,"reason":"ok"}'),
		)

		const registry: ClassifierRegistry = {
			find: () =>
				({
					id: "gpt-4.1",
					api: "azure-openai-responses",
					baseUrl: "",
					provider: "azure-openai-responses",
				}) as any,
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "azure-key",
				headers: { "x-custom": "1" },
				env: {
					AZURE_OPENAI_RESOURCE_NAME: "my-resource",
					AZURE_OPENAI_API_VERSION: "2025-03-01-preview",
				},
			}),
		}

		await classifyToolCall({
			modelRef: "azure-openai-responses/gpt-4.1",
			userMessages: [],
			pendingTool: { name: "read", input: { path: "a.ts" } },
			registry,
			timeoutMs: 5000,
		})

		const [, , options] = completeSimpleMock.mock.calls[0]!
		expect(options).toMatchObject({
			apiKey: "azure-key",
			headers: { "x-custom": "1" },
			env: {
				AZURE_OPENAI_RESOURCE_NAME: "my-resource",
				AZURE_OPENAI_API_VERSION: "2025-03-01-preview",
			},
		})
	})

	it("throws when classifier returns unparseable JSON", async () => {
		completeSimpleMock.mockResolvedValue(makeAssistantResponse("not json"))

		await expect(
			classifyToolCall({
				modelRef: "test/test-model",
				userMessages: [],
				pendingTool: { name: "bash", input: {} },
				registry: makeRegistry(),
				timeoutMs: 1000,
			}),
		).rejects.toThrow(/unparseable JSON/)
	})

	it("throws when completeSimple returns an error stop reason", async () => {
		completeSimpleMock.mockResolvedValue({
			...makeAssistantResponse(""),
			stopReason: "error",
			errorMessage: "provider failed",
		})

		await expect(
			classifyToolCall({
				modelRef: "test/test-model",
				userMessages: [],
				pendingTool: { name: "bash", input: {} },
				registry: makeRegistry(),
				timeoutMs: 1000,
			}),
		).rejects.toThrow(/provider failed/)
	})

	it("throws when model is not found", async () => {
		const registry: ClassifierRegistry = {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true }),
		}

		await expect(
			classifyToolCall({
				modelRef: "test/missing",
				userMessages: [],
				pendingTool: { name: "bash", input: {} },
				registry,
				timeoutMs: 1000,
			}),
		).rejects.toThrow(/not found/)
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

	it("does not pass array index as redaction limit for user messages", () => {
		const prompt = buildClassifierUserPrompt(["a".repeat(5000)], {
			name: "read",
			input: { path: "a.ts" },
		})
		expect(prompt).toContain("...[truncated]...")
		expect(prompt.length).toBeLessThan(6000)
	})
})

describe("redactForClassifier", () => {
	it("redacts bearer tokens", () => {
		expect(redactForClassifier("Bearer abc.def.ghi")).toContain(
			"Bearer [REDACTED]",
		)
	})

	it("redacts quoted JSON secret fields", () => {
		const redacted = redactForClassifier('{"password":"secret","api_key":"abc"}')
		expect(redacted).not.toContain("secret")
		expect(redacted).toContain('"password":"[REDACTED]"')
		expect(redacted).toContain('"api_key":"[REDACTED]"')
		expect(() => JSON.parse(redacted)).not.toThrow()
	})

	it("preserves tail when truncating long user context", () => {
		const redacted = redactForClassifier("a".repeat(5000) + "; rm -rf /")
		expect(redacted).toContain("rm -rf")
	})

	it("does not truncate pending tool JSON payloads beyond classifier cap", () => {
		const cmd = "echo ok; " + "x".repeat(5000) + "; rm -rf /"
		const prompt = buildClassifierUserPrompt([], {
			name: "bash",
			input: { command: cmd },
		})
		expect(prompt).toContain("rm -rf")
	})

	it("truncates very large pending tool JSON payloads", () => {
		const huge = "x".repeat(20_000)
		const prompt = buildClassifierUserPrompt([], {
			name: "write",
			input: { path: "big.txt", content: huge },
		})
		expect(prompt).toContain("...[truncated]...")
		expect(prompt.length).toBeLessThan(20_000)
	})
})
