import {
	applyNanoGptRoutingPreference,
	dynamicProviders,
	getModelId,
	getProviderDefaultModelId,
	isSecretStateKey,
	nanoGptDefaultModelId,
	nanoGptDefaultRoutingPreference,
	providerIdentifiers,
	providerSettingsSchema,
} from "../index.js"

describe("NanoGPT shared contract", () => {
	it("registers the stable dynamic-provider identity and default model", () => {
		expect(providerIdentifiers.nanogpt).toBe("nanogpt")
		expect(dynamicProviders).toContain(providerIdentifiers.nanogpt)
		expect(getProviderDefaultModelId(providerIdentifiers.nanogpt)).toBe(nanoGptDefaultModelId)
	})

	it("classifies the API key as secret and resolves missing routing to auto", () => {
		expect(isSecretStateKey("nanoGptApiKey")).toBe(true)
		const settings = providerSettingsSchema.parse({
			apiProvider: providerIdentifiers.nanogpt,
			nanoGptModelId: "model",
		})
		expect(settings.nanoGptRoutingPreference ?? nanoGptDefaultRoutingPreference).toBe("auto")
		expect(getModelId(settings)).toBe("model")
	})
})

describe("applyNanoGptRoutingPreference", () => {
	it.each([
		["auto", "model"],
		["fast", "model:fast"],
		["cheap", "model:cheap"],
		["latency", "model:latency"],
		["throughput", "model:throughput"],
		["tools", "model:tools"],
		["caching", "model"],
	] as const)("maps %s routing", (preference, expected) => {
		expect(applyNanoGptRoutingPreference("model", preference)).toBe(expected)
	})

	it.each([
		"speed",
		"fast",
		"throughput",
		"latency",
		"price",
		"cheap",
		"floor",
		"tools",
		"caching",
		"cache",
		"cached",
	])("replaces the recognized %s routing alias", (alias) => {
		expect(applyNanoGptRoutingPreference(`model:thinking:${alias}`, "cheap")).toBe("model:thinking:cheap")
		expect(applyNanoGptRoutingPreference(`model:thinking:${alias}`, "auto")).toBe("model:thinking")
	})

	it("preserves legitimate identity suffixes", () => {
		expect(applyNanoGptRoutingPreference("model:thinking", "fast")).toBe("model:thinking:fast")
		expect(applyNanoGptRoutingPreference("model:thinking", "auto")).toBe("model:thinking")
	})

	it("normalizes multiple trailing routing suffixes to exactly one active preference", () => {
		expect(applyNanoGptRoutingPreference("model:thinking:fast:cheap", "latency")).toBe("model:thinking:latency")
		expect(applyNanoGptRoutingPreference("model:thinking:FAST:CACHED", "auto")).toBe("model:thinking")
	})
})
