import {
	SECRET_STATE_KEYS,
	dynamicProviders,
	kimiCodeDefaultModelId,
	providerSettingsSchema,
	providerSettingsSchemaDiscriminated,
} from "../index.js"

describe("Kimi Code provider types", () => {
	it("registers Kimi Code as a dynamic provider with a distinct secret", () => {
		expect(dynamicProviders).toContain("kimi-code")
		expect(SECRET_STATE_KEYS).toContain("kimiCodeApiKey")
		expect(SECRET_STATE_KEYS).toContain("moonshotApiKey")
	})

	it("parses OAuth and API-key settings independently from Moonshot", () => {
		expect(
			providerSettingsSchemaDiscriminated.parse({
				apiProvider: "kimi-code",
				kimiCodeAuthMethod: "api-key",
				kimiCodeApiKey: "kimi-key",
				apiModelId: kimiCodeDefaultModelId,
			}),
		).toMatchObject({ kimiCodeApiKey: "kimi-key" })
		expect(providerSettingsSchema.parse({ apiProvider: "kimi-code", kimiCodeAuthMethod: "oauth" })).toMatchObject({
			kimiCodeAuthMethod: "oauth",
		})
	})
})
