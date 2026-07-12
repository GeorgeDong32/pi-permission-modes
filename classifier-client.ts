/**
 * Built-in classifier LLM client for auto-mode tool-call review.
 * Uses pi-ai completeSimple + ctx.modelRegistry auth resolution.
 */

import {
	completeSimple,
	type Api,
	type Context,
	type Model,
} from "@earendil-works/pi-ai/compat"

export type ClassifierVerdict = { allow: boolean; reason: string }

export type ResolvedAuth =
	| {
			ok: true
			apiKey?: string
			headers?: Record<string, string>
			env?: Record<string, string>
	  }
	| { ok: false; error: string }

export interface ClassifierRegistry {
	find(provider: string, modelId: string): Model<Api> | undefined
	getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedAuth>
}

const CLASSIFIER_SYSTEM = `You are a security classifier for an AI coding agent.
Review the pending tool call in context of the user's recent messages.
Reply with JSON only: {"allow": boolean, "reason": string}
- allow=true when the tool call clearly serves the user's stated goal safely
- allow=false when the call is risky, unrelated, or unnecessarily destructive
Keep reason under one sentence.`

export function parseModelRef(
	modelRef: string,
): { provider: string; modelId: string } | null {
	const slash = modelRef.indexOf("/")
	if (slash <= 0) return null
	const provider = modelRef.slice(0, slash)
	const modelId = modelRef.slice(slash + 1)
	if (!provider || !modelId) return null
	return { provider, modelId }
}

export function buildClassifierUserPrompt(
	userMessages: string[],
	pendingTool: { name: string; input: unknown },
): string {
	const recent = userMessages
		.slice(-2)
		.map((msg) => redactForClassifier(msg))
		.join("\n---\n")
	const toolJson = redactForClassifier(
		JSON.stringify(pendingTool, null, 2),
		8000,
	)
	return `Recent user messages:
${recent || "(none)"}

Pending tool call:
${toolJson}`
}

/** Redact likely secrets before sending to classifier provider. */
export function redactForClassifier(
	text: string,
	limit = 4000,
): string {
	const redacted = text
		.replace(/\bsk-[a-zA-Z0-9_-]{16,}\b/g, "sk-[REDACTED]")
		.replace(/\bBearer\s+[A-Za-z0-9._-]+\b/gi, "Bearer [REDACTED]")
		.replace(
			/"((?:api[_-]?key|token|password))"\s*:\s*"[^"]*"/gi,
			'"$1":"[REDACTED]"',
		)
		.replace(
			/"((?:api[_-]?key|token|password))"\s*:\s*(?!")[^,\s}\]]+/gi,
			'"$1":"[REDACTED]"',
		)
		.replace(/\b(api[_-]?key|token|password)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
	if (!Number.isFinite(limit) || redacted.length <= limit) return redacted
	const tailLen = Math.min(1000, Math.floor(limit / 3))
	const headLen = limit - tailLen - 15
	return (
		redacted.slice(0, headLen) +
		"\n...[truncated]...\n" +
		redacted.slice(-tailLen)
	)
}

export function parseClassifierVerdict(text: string): ClassifierVerdict | null {
	const trimmed = text.trim()
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
	const candidate = fenced ? fenced[1]!.trim() : trimmed
	const start = candidate.indexOf("{")
	const end = candidate.lastIndexOf("}")
	if (start === -1 || end === -1 || end <= start) return null
	try {
		const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
			allow?: unknown
			reason?: unknown
		}
		if (typeof parsed.allow !== "boolean") return null
		return {
			allow: parsed.allow,
			reason:
				typeof parsed.reason === "string" && parsed.reason.trim()
					? parsed.reason.trim()
					: parsed.allow
						? "Classifier approved"
						: "Classifier denied",
		}
	} catch {
		return null
	}
}

function extractTextContent(
	content: Array<{ type: string; text?: string }>,
): string {
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text!)
		.join("\n")
}

async function runClassifierCompletion(
	model: Model<Api>,
	auth: Extract<ResolvedAuth, { ok: true }>,
	userPrompt: string,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<string> {
	const context: Context = {
		systemPrompt: CLASSIFIER_SYSTEM,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: userPrompt }],
				timestamp: Date.now(),
			},
		],
	}

	const response = await completeSimple(model, context, {
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
		signal,
		timeoutMs,
		maxTokens: 256,
		temperature: 0,
	})

	if (response.stopReason === "aborted") {
		throw new Error("Classifier request aborted")
	}
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "Classifier request failed")
	}

	return extractTextContent(response.content)
}

export async function classifyToolCall(opts: {
	modelRef: string
	userMessages: string[]
	pendingTool: { name: string; input: unknown }
	registry: ClassifierRegistry
	signal?: AbortSignal
	timeoutMs: number
}): Promise<ClassifierVerdict> {
	const parsed = parseModelRef(opts.modelRef)
	if (!parsed) throw new Error(`Invalid classifier model ref: ${opts.modelRef}`)

	const model = opts.registry.find(parsed.provider, parsed.modelId)
	if (!model) throw new Error(`Classifier model not found: ${opts.modelRef}`)

	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), opts.timeoutMs)
	const onAbort = () => controller.abort()
	opts.signal?.addEventListener("abort", onAbort)

	try {
		const auth = await opts.registry.getApiKeyAndHeaders(model)
		if (!auth.ok) throw new Error(auth.error)

		const text = await runClassifierCompletion(
			model,
			auth,
			buildClassifierUserPrompt(opts.userMessages, opts.pendingTool),
			controller.signal,
			opts.timeoutMs,
		)
		const verdict = parseClassifierVerdict(text)
		if (!verdict) throw new Error("Classifier returned unparseable JSON")
		return verdict
	} finally {
		clearTimeout(timeout)
		opts.signal?.removeEventListener("abort", onAbort)
	}
}
