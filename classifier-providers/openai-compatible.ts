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

export async function completeOpenAiCompatible(
	opts: ProviderRequestOpts,
): Promise<string> {
	const { model, auth, systemPrompt, userPrompt, signal } = opts
	const res = await fetch(joinUrl(model.baseUrl, "/v1/chat/completions"), {
		method: "POST",
		headers: mergeHeaders(auth, model.headers),
		body: JSON.stringify({
			model: model.id,
			max_tokens: 256,
			temperature: 0,
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userPrompt },
			],
		}),
		signal,
	})
	if (!res.ok) {
		const body = await res.text().catch(() => "")
		throw new Error(`OpenAI API ${res.status}: ${body.slice(0, 200)}`)
	}
	const data = (await res.json()) as {
		choices?: Array<{ message?: { content?: string } }>
	}
	const text = data.choices?.[0]?.message?.content
	if (!text) throw new Error("OpenAI response missing message content")
	return text
}
