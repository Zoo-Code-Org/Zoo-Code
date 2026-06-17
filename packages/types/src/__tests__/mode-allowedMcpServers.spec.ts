import { modeConfigSchema } from "../mode.js"

describe("modeConfigSchema allowedMcpServers", () => {
	const baseModeConfig = {
		slug: "test-mode",
		name: "Test Mode",
		roleDefinition: "A test mode",
		groups: ["read" as const],
	}

	it("should accept valid allowedMcpServers array of strings", () => {
		const result = modeConfigSchema.safeParse({
			...baseModeConfig,
			allowedMcpServers: ["server1", "server2"],
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.allowedMcpServers).toEqual(["server1", "server2"])
		}
	})

	it("should accept missing/undefined allowedMcpServers", () => {
		const result = modeConfigSchema.safeParse(baseModeConfig)
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.allowedMcpServers).toBeUndefined()
		}
	})

	it("should accept empty allowedMcpServers array", () => {
		const result = modeConfigSchema.safeParse({
			...baseModeConfig,
			allowedMcpServers: [],
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.allowedMcpServers).toEqual([])
		}
	})

	it("should reject non-string array items", () => {
		const result = modeConfigSchema.safeParse({
			...baseModeConfig,
			allowedMcpServers: [123, 456],
		})
		expect(result.success).toBe(false)
	})

	it("should reject non-array value", () => {
		const result = modeConfigSchema.safeParse({
			...baseModeConfig,
			allowedMcpServers: "server1",
		})
		expect(result.success).toBe(false)
	})
})
