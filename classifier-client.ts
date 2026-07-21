/**
 * CC-style auto-mode classifier client for pi.
 * Uses pi-ai completeSimple + CC transcript / system prompt assembly.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
	completeSimple,
	type Api,
	type Context,
	type Model,
} from "@earendil-works/pi-ai/compat"
import {
	buildClassifierSystemPrompt,
	type AutoModeRules,
} from "./classifier-prompt.ts"
import { redactForClassifier } from "./classifier-redact.ts"
import {
	buildTranscriptForClassifier,
	compactTranscriptEntry,
	formatActionForClassifier,
	type TranscriptEntry,
} from "./classifier-transcript.ts"
import { toClassifierInput } from "./classifier-tool-projection.ts"

export type ClassifierVerdict = {
	allow: boolean
	reason: string
	thinking?: string
	unavailable?: boolean
}

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

export type ClassifierSessionContext = {
	cwd: string
	mode: string
	branch: Array<{ type?: string; message?: { role?: string; content?: unknown } }>
	reviewHint?: string
	agentsMd?: string | null
}

export { redactForClassifier } from "./classifier-redact.ts"

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

export function readAgentsMdForClassifier(cwd: string): string | null {
	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		const path = join(cwd, name)
		try {
			if (!existsSync(path)) continue
			const text = readFileSync(path, "utf-8").trim()
			if (text) return text
		} catch {
			// ignore
		}
	}
	return null
}

function buildAgentsMdPrefix(agentsMd: string): string {
	return (
		`The following is the user's project agent configuration. These are ` +
		`instructions the user provided and should be treated as part of the ` +
		`user's intent when evaluating actions.\n\n` +
		`<user_agents_md>\n${redactForClassifier(agentsMd, 8000)}\n</user_agents_md>\n\n`
	)
}

export function buildClassifierUserPrompt(opts: {
	session: ClassifierSessionContext
	pendingTool: { name: string; input: unknown }
	jsonlTranscript?: boolean
}): string {
	const action = formatActionForClassifier(
		opts.pendingTool.name,
		opts.pendingTool.input,
	)
	const actionCompact = compactTranscriptEntry(
		action,
		opts.jsonlTranscript ?? false,
	)
	const transcript = buildTranscriptForClassifier(
		opts.session.branch,
		opts.jsonlTranscript ?? false,
	)
	const reviewHint = opts.session.reviewHint?.trim()
	const sessionHeader = [
		`Session context:`,
		`- mode: ${opts.session.mode}`,
		`- cwd: ${opts.session.cwd}`,
		reviewHint ? `- tier-3 hint: ${reviewHint}` : "",
	]
		.filter(Boolean)
		.join("\n")

	const agentsPrefix = opts.session.agentsMd
		? buildAgentsMdPrefix(opts.session.agentsMd)
		: ""

	return `${agentsPrefix}${sessionHeader}

Transcript (user messages and prior tool calls; assistant reasoning excluded):
${transcript || "(none)"}

Pending action to classify:
${actionCompact}`
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
			shouldBlock?: unknown
			reason?: unknown
			thinking?: unknown
		}
		const thinking =
			typeof parsed.thinking === "string" && parsed.thinking.trim()
				? parsed.thinking.trim()
				: undefined
		const reason =
			typeof parsed.reason === "string" && parsed.reason.trim()
				? parsed.reason.trim()
				: undefined

		if (typeof parsed.shouldBlock === "boolean") {
			return {
				allow: !parsed.shouldBlock,
				reason:
					reason ??
					(parsed.shouldBlock
						? "Classifier blocked"
						: "Classifier approved"),
				thinking,
			}
		}
		if (typeof parsed.allow === "boolean") {
			return {
				allow: parsed.allow,
				reason:
					reason ??
					(parsed.allow ? "Classifier approved" : "Classifier denied"),
				thinking,
			}
		}
		return null
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
	systemPrompt: string,
	userPrompt: string,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<string> {
	const context: Context = {
		systemPrompt,
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
		maxTokens: 512,
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
	session: ClassifierSessionContext
	pendingTool: { name: string; input: unknown }
	registry: ClassifierRegistry
	autoMode?: AutoModeRules
	signal?: AbortSignal
	timeoutMs: number
	jsonlTranscript?: boolean
	debug?: boolean
}): Promise<ClassifierVerdict> {
	const encoded = toClassifierInput(
		opts.pendingTool.name,
		(opts.pendingTool.input ?? {}) as Record<string, unknown>,
	)
	if (encoded === "") {
		return {
			allow: true,
			reason: "Tool declares no classifier-relevant input",
		}
	}

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

		const systemPrompt = buildClassifierSystemPrompt(opts.autoMode)
		const userPrompt = buildClassifierUserPrompt({
			session: opts.session,
			pendingTool: opts.pendingTool,
			jsonlTranscript: opts.jsonlTranscript,
		})

		if (opts.debug) {
			console.debug(
				"[permission-modes] Classifier request:",
				JSON.stringify({
					model: opts.modelRef,
					tool: opts.pendingTool.name,
					systemChars: systemPrompt.length,
					userChars: userPrompt.length,
				}),
			)
		}

		const text = await runClassifierCompletion(
			model,
			auth,
			systemPrompt,
			userPrompt,
			controller.signal,
			opts.timeoutMs,
		)
		const verdict = parseClassifierVerdict(text)
		if (!verdict) throw new Error("Classifier returned unparseable JSON")

		if (opts.debug) {
			console.debug(
				"[permission-modes] Classifier verdict:",
				JSON.stringify(verdict),
			)
		}
		return verdict
	} finally {
		clearTimeout(timeout)
		opts.signal?.removeEventListener("abort", onAbort)
	}
}

export type { TranscriptEntry }
