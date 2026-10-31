import {
	SECRET_STATE_KEYS,
	getMimoModelInfo,
	isSecretStateKey,
	mimoDefaultModelInfo,
	mimoModels,
	providerIdentifiers,
	providerSettingsSchema,
} from "../index.js"

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

describe("getMimoModelInfo", () => {
	it("returns the curated spec for a known model ID", () => {
		expect(getMimoModelInfo("mimo-v2.6-pro")).toBe(mimoModels["mimo-v2.6-pro"])
	})

	it("returns undefined for an unknown model ID", () => {
		expect(getMimoModelInfo("mimo-v99-not-real")).toBeUndefined()
	})

	// Regression: model IDs reach this lookup from the provider's /models response,
	// so a plain `mimoModels[id]` read resolved Object.prototype members and handed
	// callers a function (or `{}` after spreading) instead of the family default.
	it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"])(
		"returns undefined for the inherited Object.prototype key %s",
		(key) => {
			expect(getMimoModelInfo(key)).toBeUndefined()
		},
	)

	it("keeps the default model resolvable so the fallback path has a spec", () => {
		expect(getMimoModelInfo("mimo-v2.6-pro")).toBe(mimoDefaultModelInfo)
	})
})
