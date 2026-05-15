import { expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"

import { snapshot } from "@/provider/models-snapshot"
import { ProviderTransform } from "@/provider/transform"
import { Provider } from "@/provider/provider"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { ProviderID } from "../../src/provider/schema"
import { tmpdir } from "../fixture/fixture"

async function listProviders() {
	return AppRuntime.runPromise(
		Effect.gen(function* () {
			const provider = yield* Provider.Service
			return yield* provider.list()
		}),
	)
}

test("Zoo/Roo catalog-backed providers are present in the bundled model snapshot", () => {
	expect(snapshot.requesty?.npm).toBe("@ai-sdk/openai-compatible")
	expect(snapshot.requesty?.api).toBe("https://router.requesty.ai/v1")
	expect(snapshot.requesty?.env).toContain("REQUESTY_API_KEY")

	expect(snapshot.baseten?.npm).toBe("@ai-sdk/openai-compatible")
	expect(snapshot.baseten?.api).toBe("https://inference.baseten.co/v1")
	expect(snapshot.baseten?.env).toContain("BASETEN_API_KEY")

	expect(snapshot.poe?.npm).toBe("@ai-sdk/openai-compatible")
	expect(snapshot.poe?.api).toBe("https://api.poe.com/v1")
	expect(snapshot.poe?.env).toContain("POE_API_KEY")

	expect(snapshot.lmstudio?.npm).toBe("@ai-sdk/openai-compatible")
	expect(snapshot.lmstudio?.api).toBe("http://127.0.0.1:1234/v1")
})

test("config-only Zoo/Roo providers load as OpenAI-compatible custom providers", async () => {
	await using tmp = await tmpdir({
		init: async (dir) => {
			await Bun.write(
				path.join(dir, "zoo.jsonc"),
				JSON.stringify({
					$schema: "https://zoo-code.ai/config.json",
					provider: {
						litellm: {
							name: "LiteLLM",
							npm: "@ai-sdk/openai-compatible",
							api: "http://localhost:4000/v1",
							env: ["LITELLM_API_KEY"],
							models: { "proxy-model": { name: "Proxy Model" } },
							options: { apiKey: "test-key", baseURL: "http://localhost:4000/v1" },
						},
						ollama: {
							name: "Ollama",
							npm: "@ai-sdk/openai-compatible",
							api: "http://localhost:11434/v1",
							env: [],
							models: { llama3: { name: "Llama 3" } },
							options: { apiKey: "ollama", baseURL: "http://localhost:11434/v1" },
						},
						unbound: {
							name: "Unbound",
							npm: "@ai-sdk/openai-compatible",
							api: "https://api.getunbound.ai/v1",
							env: ["UNBOUND_API_KEY"],
							models: { "unbound-model": { name: "Unbound Model" } },
							options: { apiKey: "test-key", baseURL: "https://api.getunbound.ai/v1" },
						},
						sambanova: {
							name: "SambaNova",
							npm: "@ai-sdk/openai-compatible",
							api: "https://api.sambanova.ai/v1",
							env: ["SAMBANOVA_API_KEY"],
							models: { "sambanova-model": { name: "SambaNova Model" } },
							options: { apiKey: "test-key", baseURL: "https://api.sambanova.ai/v1" },
						},
					},
				}),
			)
		},
	})

	await Instance.provide({
		directory: tmp.path,
		fn: async () => {
			const providers = await listProviders()

			for (const id of ["litellm", "ollama", "unbound", "sambanova"] as const) {
				const provider = providers[ProviderID.make(id)]
				expect(provider).toBeDefined()
				expect(provider.source).toBe("config")
				expect(provider.options.baseURL).toBeDefined()
				expect(Object.values(provider.models)[0].api.npm).toBe("@ai-sdk/openai-compatible")
			}
		},
	})
})

test("Baseten models keep their OpenAI-compatible thinking template option", () => {
	const options = ProviderTransform.options({
		sessionID: "session-1",
		providerOptions: {},
		model: {
			id: "baseten/Kimi-K2-Instruct-FP4",
			providerID: "baseten",
			api: {
				id: "baseten/Kimi-K2-Instruct-FP4",
				npm: "@ai-sdk/openai-compatible",
				url: "https://inference.baseten.co/v1",
			},
			name: "Kimi K2 Instruct FP4",
			capabilities: {
				temperature: true,
				reasoning: true,
				attachment: false,
				toolcall: true,
				input: { text: true, audio: false, image: false, video: false, pdf: false },
				output: { text: true, audio: false, image: false, video: false, pdf: false },
				interleaved: false,
			},
			cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
			limit: { context: 128000, output: 4096 },
			status: "active",
			options: {},
			headers: {},
			release_date: "",
		} as Provider.Model,
	})

	expect(options.chat_template_args).toEqual({ enable_thinking: true })
})
