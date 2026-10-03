import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import {
	API_MODEL_ID_FIELD,
	apiModelIdProviderModelShape,
	createModelIdAccessor,
	createProviderDefinition,
} from "./common.js"

export const mimoProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.mimo,
	modelIdKey: API_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(API_MODEL_ID_FIELD),
	schema: {
		...apiModelIdProviderModelShape,
		// The four allowed Xiaomi MiMo endpoints. Runtime paths that read this
		// value BEFORE schema validation can apply — unsaved webview values, the
		// fail-open ContextProxy path, the chat-completion client — all enforce
		// the same set via ALLOWED_BASE_URLS in
		// src/api/providers/fetchers/mimo.ts; keep these literals in sync with
		// that set (fetcher tests cross-check both directions of the mapping).
		mimoBaseUrl: z
			.union([
				z.literal("https://api.xiaomimimo.com/v1"),
				z.literal("https://token-plan-cn.xiaomimimo.com/v1"),
				z.literal("https://token-plan-sgp.xiaomimimo.com/v1"),
				z.literal("https://token-plan-ams.xiaomimimo.com/v1"),
			])
			.optional(),
		mimoApiKey: z.string().optional(),
	},
})
