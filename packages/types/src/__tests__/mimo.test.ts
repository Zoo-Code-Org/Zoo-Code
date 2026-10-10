import { SECRET_STATE_KEYS, isSecretStateKey, providerIdentifiers, providerSettingsSchema } from "../index.js"

describe("MiMo provider secret classification", () => {
	it("classifies mimoApiKey as a secret state key alongside its sibling provider keys", () => {
		expect(SECRET_STATE_KEYS).toContain("mimoApiKey")
		expect(isSecretStateKey("mimoApiKey")).toBe(true)
	})

	it("keeps the non-secret MiMo settings out of the secret set", () => {
		expect(isSecretStateKey("mimoBaseUrl")).toBe(false)
		expect(SECRET_STATE_KEYS).not.toContain("mimoBaseUrl")
	})

	it("still parses and exposes mimoApiKey through the provider settings schema", () => {
		const parsed = providerSettingsSchema.parse({
			apiProvider: providerIdentifiers.mimo,
			mimoApiKey: "mimo-key",
			mimoBaseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
		})
		expect(parsed.mimoApiKey).toBe("mimo-key")
		expect(parsed.mimoBaseUrl).toBe("https://token-plan-sgp.xiaomimimo.com/v1")
	})
})
