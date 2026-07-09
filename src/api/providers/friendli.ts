import { type FriendliModelId, friendliDefaultModelId, friendliModels } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"

import { BaseOpenAiCompatibleProvider } from "./base-openai-compatible-provider"

/**
 * Handler for the Friendli Model APIs (OpenAI-compatible).
 * Routes chat completions to `https://api.friendli.ai/serverless/v1`.
 */
export class FriendliHandler extends BaseOpenAiCompatibleProvider<FriendliModelId> {
	/**
	 * @param options  Provider settings; `friendliApiKey` is required.
	 */
	constructor(options: ApiHandlerOptions) {
		super({
			...options,
			providerName: "Friendli",
			baseURL: "https://api.friendli.ai/serverless/v1",
			apiKey: options.friendliApiKey,
			defaultProviderModelId: friendliDefaultModelId,
			providerModels: friendliModels,
			defaultTemperature: 0.6,
		})
	}
}
