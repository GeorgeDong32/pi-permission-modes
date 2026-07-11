import type { ProviderRequestOpts } from "./types.ts"

function joinUrl(baseUrl: string, path: string): string {
	const base = baseUrl.replace(/\/$/, "")
	return `${base}${path}`
}

function mergeHeaders(
	auth: ProviderRequestOpts["auth"],
	modelHeaders?: Record<string, string>,
): Record<string, string> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		...modelHeaders,
		...auth.headers,
	}
	if (auth.apiKey && !headers.authorization) {
		headers.authorization = `Bearer ${auth.apiKey}`
	}
	return headers
}

function extractResponsesText(data: {
	output?: Array<{
		type?: string
		content?: Array<{ type?: string; text?: string }>
	}>
}): string | undefined {
	for (const item of data.output ?? []) {
		if (item.type !== "message") continue
		for (const block of item.content ?? []) {
			if (block.type === "output_text" && block.text) return block.text
		}
	}
	return undefined
}

export async function completeOpenAiResponses(
	opts: ProviderRequestOpts,
): Promise<string> {
	const { model, auth, systemPrompt, userPrompt, signal } = opts
	const res = await fetch(joinUrl(model.baseUrl, "/v1/responses"), {
		method: "POST",
		headers: mergeHeaders(auth, model.headers),
		body: JSON.stringify({
			model: model.id,
			max_output_tokens: 256,
			temperature: 0,
			input: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userPrompt },
			],
		}),
		signal,
	})
	if (!res.ok) {
		const body = await res.text().catch(() => "")
		throw new Error(`OpenAI Responses API ${res.status}: ${body.slice(0, 200)}`)
	}
	const data = (await res.json()) as Parameters<typeof extractResponsesText>[0]
	const text = extractResponsesText(data)
	if (!text) throw new Error("OpenAI Responses missing output text")
	return text
}
