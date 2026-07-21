import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	buildClassifierUserPrompt,
	classifyToolCall,
	parseClassifierVerdict,
	parseModelRef,
	type ClassifierRegistry,
	type ClassifierSessionContext,
} from "./classifier-client.ts"
import { redactForClassifier } from "./classifier-redact.ts"

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}))

vi.mock("@earendil-works/pi-ai/compat", () => ({
	completeSimple: completeSimpleMock,
}))

function session(
	overrides: Partial<ClassifierSessionContext> = {},
): ClassifierSessionContext {
	return {
		cwd: "/proj",
		mode: "auto",
		branch: [],
		...overrides,
	}
}

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
	it("parses CC shouldBlock JSON", () => {
		expect(
			parseClassifierVerdict(
				'{"thinking":"ok","shouldBlock":false,"reason":"routine"}',
			),
		).toEqual({ allow: true, reason: "routine", thinking: "ok" })
	})

	it("parses legacy allow JSON", () => {
		expect(parseClassifierVerdict('{"allow":false,"reason":"risky"}')).toEqual({
			allow: false,
			reason: "risky",
		})
	})

	it("parses fenced JSON", () => {
		expect(
			parseClassifierVerdict('```json\n{"shouldBlock":true,"reason":"no"}\n```'),
		).toEqual({ allow: false, reason: "no" })
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

	it("uses CC system prompt and transcript user prompt", async () => {
		completeSimpleMock.mockResolvedValue(
			makeAssistantResponse(
				'{"shouldBlock":false,"reason":"fine","thinking":"ok"}',
			),
		)

		const verdict = await classifyToolCall({
			modelRef: "test/test-model",
			session: session({
				branch: [
					{
						type: "message",
						message: { role: "user", content: "fix the bug" },
					},
				],
			}),
			pendingTool: { name: "bash", input: { command: "npm test" } },
			registry: makeRegistry(),
			timeoutMs: 5000,
		})

		expect(verdict.allow).toBe(true)
		expect(completeSimpleMock).toHaveBeenCalledTimes(1)
		const [, context, options] = completeSimpleMock.mock.calls[0]!
		expect(context.systemPrompt).toContain("automated security classifier")
		expect(context.systemPrompt).toContain("Allow Rules")
		expect(context.messages[0]?.content[0]).toEqual({
			type: "text",
			text: expect.stringContaining("fix the bug"),
		})
		expect(context.messages[0]?.content[0].text).toContain("npm test")
		expect(options).toMatchObject({
			apiKey: "test-key",
			maxTokens: 512,
			temperature: 0,
		})
	})

	it("auto-allows when tool has no classifier-relevant input", async () => {
		const verdict = await classifyToolCall({
			modelRef: "test/test-model",
			session: session(),
			pendingTool: { name: "read", input: {} },
			registry: makeRegistry(),
			timeoutMs: 5000,
		})
		expect(verdict.allow).toBe(true)
		expect(completeSimpleMock).not.toHaveBeenCalled()
	})

	it("returns deny verdict from classifier output", async () => {
		completeSimpleMock.mockResolvedValue(
			makeAssistantResponse('{"shouldBlock":true,"reason":"no"}'),
		)

		const verdict = await classifyToolCall({
			modelRef: "test/test-model",
			session: session(),
			pendingTool: { name: "bash", input: { command: "rm -rf /" } },
			registry: makeRegistry(),
			timeoutMs: 5000,
		})
		expect(verdict.allow).toBe(false)
	})

	it("throws when classifier returns unparseable JSON", async () => {
		completeSimpleMock.mockResolvedValue(makeAssistantResponse("not json"))

		await expect(
			classifyToolCall({
				modelRef: "test/test-model",
				session: session(),
				pendingTool: { name: "bash", input: { command: "ls" } },
				registry: makeRegistry(),
				timeoutMs: 1000,
			}),
		).rejects.toThrow(/unparseable JSON/)
	})

	it("throws when model is not found", async () => {
		const registry: ClassifierRegistry = {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true }),
		}

		await expect(
			classifyToolCall({
				modelRef: "test/missing",
				session: session(),
				pendingTool: { name: "bash", input: { command: "ls" } },
				registry,
				timeoutMs: 1000,
			}),
		).rejects.toThrow(/not found/)
	})
})

describe("buildClassifierUserPrompt", () => {
	it("includes transcript and excludes assistant text", () => {
		const prompt = buildClassifierUserPrompt({
			session: session({
				reviewHint: "bash not on read-only allowlist",
				branch: [
					{
						type: "message",
						message: { role: "user", content: "hello" },
					},
					{
						type: "message",
						message: {
							role: "assistant",
							content: [
								{ type: "text", text: "I will run tests" },
								{
									type: "toolCall",
									id: "1",
									name: "bash",
									arguments: { command: "npm test" },
								},
							],
						},
					},
				],
			}),
			pendingTool: { name: "bash", input: { command: "npm install" } },
		})
		expect(prompt).toContain("mode: auto")
		expect(prompt).toContain("/proj")
		expect(prompt).toContain("User: hello")
		expect(prompt).toContain("bash npm test")
		expect(prompt).not.toContain("I will run tests")
		expect(prompt).toContain("npm install")
	})

	it("redacts secrets in transcript", () => {
		const prompt = buildClassifierUserPrompt({
			session: session({
				branch: [
					{
						type: "message",
						message: {
							role: "user",
							content: "token sk-abcdefghijklmnopqrstuvwxyz",
						},
					},
				],
			}),
			pendingTool: { name: "bash", input: { command: "echo" } },
		})
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

	it("preserves tail when truncating long context", () => {
		const redacted = redactForClassifier("a".repeat(5000) + "; rm -rf /")
		expect(redacted).toContain("rm -rf")
	})
})
