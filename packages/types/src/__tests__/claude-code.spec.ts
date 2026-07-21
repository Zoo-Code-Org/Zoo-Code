import { describe, it, expect } from "vitest"

import { claudeCodeModels, claudeCodeDefaultModelId } from "../providers/claude-code.js"
import { providerSettingsSchema, providerSettingsSchemaDiscriminated } from "../provider-settings.js"

describe("claudeCodeModels", () => {
	it("default model ID exists in the models record", () => {
		expect(claudeCodeModels).toHaveProperty(claudeCodeDefaultModelId)
	})

	it("all models have inputPrice: 0 and outputPrice: 0", () => {
		for (const [id, model] of Object.entries(claudeCodeModels)) {
			expect(model.inputPrice, `${id}: inputPrice must be 0`).toBe(0)
			expect(model.outputPrice, `${id}: outputPrice must be 0`).toBe(0)
		}
	})
})

describe("claudeCodeSchema (via providerSettingsSchema)", () => {
	it("accepts an empty object", () => {
		const result = providerSettingsSchema.safeParse({})
		expect(result.success).toBe(true)
	})

	it("accepts claudeCodeCliPath as an optional string", () => {
		const result = providerSettingsSchema.safeParse({ claudeCodeCliPath: "/usr/local/bin/claude" })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.claudeCodeCliPath).toBe("/usr/local/bin/claude")
		}
	})

	it("rejects unknown keys in strict mode", () => {
		const result = providerSettingsSchema.strict().safeParse({ claudeCodeApiKey: "should-not-exist" })
		expect(result.success).toBe(false)
	})
})

describe("claudeCodeSchema (via providerSettingsSchemaDiscriminated)", () => {
	it("accepts apiProvider: 'claude-code' with no other fields", () => {
		const result = providerSettingsSchemaDiscriminated.safeParse({ apiProvider: "claude-code" })
		expect(result.success).toBe(true)
	})

	it("accepts apiProvider: 'claude-code' with claudeCodeCliPath", () => {
		const result = providerSettingsSchemaDiscriminated.safeParse({
			apiProvider: "claude-code",
			claudeCodeCliPath: "/usr/local/bin/claude",
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.apiProvider).toBe("claude-code")
		}
	})
})
