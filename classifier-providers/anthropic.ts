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
		"anthropic-version": "2023-06-01",
		...modelHeaders,
		...auth.headers,
	}
	if (auth.apiKey) headers["x-api-key"] = auth.apiKey
	return headers
}

export async function completeAnthropic(
	opts: ProviderRequestOpts,
): Promise<string> {
	const { model, auth, systemPrompt, userPrompt, signal } = opts
	const res = await fetch(joinUrl(model.baseUrl, "/v1/messages"), {
		method: "POST",
		headers: mergeHeaders(auth, model.headers),
		body: JSON.stringify({
			model: model.id,
			max_tokens: 256,
			temperature: 0,
			system: systemPrompt,
			messages: [{ role: "user", content: userPrompt }],
		}),
		signal,
	})
	if (!res.ok) {
		const body = await res.text().catch(() => "")
		throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`)
	}
	const data = (await res.json()) as {
		content?: Array<{ type?: string; text?: string }>
	}
	const text = data.content?.find((b) => b.type === "text")?.text
	if (!text) throw new Error("Anthropic response missing text content")
	return text
}
