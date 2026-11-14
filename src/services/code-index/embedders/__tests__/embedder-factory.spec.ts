import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

import { EmbedderFactory } from "../embedder-factory"
import { BedrockEmbedder } from "../bedrock"
import { ProviderPacerRegistry } from "../../provider-pacer"
import type { CodeIndexConfig } from "../../interfaces/config"

vi.mock("../bedrock", () => ({ BedrockEmbedder: vi.fn() }))

describe("EmbedderFactory (CI-EM-03)", () => {
	const config: CodeIndexConfig = {
		isConfigured: true,
		embedderProvider: providerIdentifiers.bedrock,
		modelId: "amazon.titan-embed-text-v2:0",
		bedrockOptions: { region: "us-east-1", profile: "dev" },
	}

	it("passes the workspace pacer registry through to BedrockEmbedder", () => {
		const pacers = new ProviderPacerRegistry()
		new EmbedderFactory().create(config, pacers)
		expect(BedrockEmbedder).toHaveBeenLastCalledWith("us-east-1", "dev", "amazon.titan-embed-text-v2:0", pacers)
	})
})
