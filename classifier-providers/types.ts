export interface ClassifierModel {
	id: string
	api: string
	baseUrl: string
	provider: string
	headers?: Record<string, string>
}

export type ResolvedAuth =
	| {
			ok: true
			apiKey?: string
			headers?: Record<string, string>
	  }
	| { ok: false; error: string }

export interface ClassifierRegistry {
	find(provider: string, modelId: string): ClassifierModel | undefined
	getApiKeyAndHeaders(model: ClassifierModel): Promise<ResolvedAuth>
}

export interface ProviderRequestOpts {
	model: ClassifierModel
	auth: Extract<ResolvedAuth, { ok: true }>
	systemPrompt: string
	userPrompt: string
	signal?: AbortSignal
}
