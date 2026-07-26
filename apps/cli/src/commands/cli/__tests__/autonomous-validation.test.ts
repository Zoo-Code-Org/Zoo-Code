import { validateAutonomousFlags, validateProviderBaseUrl } from "../autonomous-validation.js"

describe("validateAutonomousFlags", () => {
	it("returns no errors for valid autonomous configuration", () => {
		const errors = validateAutonomousFlags({
			autonomous: true,
			print: true,
			workspace: "/path/to/workspace",
			timeout: 300,
			provider: "openrouter",
		})
		expect(errors).toEqual([])
	})

	it("returns no errors when autonomous is false regardless of other flags", () => {
		const errors = validateAutonomousFlags({
			autonomous: false,
			mode: "code",
			requireApproval: true,
			print: false,
		})
		expect(errors).toEqual([])
	})

	it("returns error when mode is specified with autonomous", () => {
		const errors = validateAutonomousFlags({
			autonomous: true,
			mode: "code",
			print: true,
			workspace: "/path",
			timeout: 300,
		})
		expect(errors).toHaveLength(1)
		expect(errors[0]!.message).toContain("--mode cannot be used with --autonomous")
	})

	it("returns error when requireApproval is true with autonomous", () => {
		const errors = validateAutonomousFlags({
			autonomous: true,
			requireApproval: true,
			print: true,
			workspace: "/path",
			timeout: 300,
		})
		expect(errors).toHaveLength(1)
		expect(errors[0]!.message).toContain("--require-approval cannot be used with --autonomous")
	})

	it("returns error when print is false with autonomous", () => {
		const errors = validateAutonomousFlags({
			autonomous: true,
			print: false,
			workspace: "/path",
			timeout: 300,
		})
		expect(errors).toHaveLength(1)
		expect(errors[0]!.message).toContain("--autonomous requires --print")
	})

	it("returns error when stdinPromptStream is true with autonomous", () => {
		const errors = validateAutonomousFlags({
			autonomous: true,
			stdinPromptStream: true,
			print: true,
			workspace: "/path",
			timeout: 300,
		})
		expect(errors).toHaveLength(1)
		expect(errors[0]!.message).toContain("cannot use --stdin-prompt-stream")
	})

	it("returns error when workspace is not specified with autonomous", () => {
		const errors = validateAutonomousFlags({
			autonomous: true,
			print: true,
			timeout: 300,
		})
		expect(errors).toHaveLength(1)
		expect(errors[0]!.message).toContain("--autonomous requires an explicit --workspace")
	})

	it("returns error when timeout is not specified with autonomous", () => {
		const errors = validateAutonomousFlags({
			autonomous: true,
			print: true,
			workspace: "/path",
		})
		expect(errors).toHaveLength(1)
		expect(errors[0]!.message).toContain("--autonomous requires --timeout")
	})

	it("returns error when timeout is zero with autonomous", () => {
		const errors = validateAutonomousFlags({
			autonomous: true,
			print: true,
			workspace: "/path",
			timeout: 0,
		})
		expect(errors).toHaveLength(1)
		expect(errors[0]!.message).toContain("--autonomous requires --timeout")
	})

	it("returns error when timeout is negative with autonomous", () => {
		const errors = validateAutonomousFlags({
			autonomous: true,
			print: true,
			workspace: "/path",
			timeout: -10,
		})
		expect(errors).toHaveLength(1)
		expect(errors[0]!.message).toContain("--autonomous requires --timeout")
	})

	it("returns error when timeout is NaN with autonomous", () => {
		const errors = validateAutonomousFlags({
			autonomous: true,
			print: true,
			workspace: "/path",
			timeout: NaN,
		})
		expect(errors).toHaveLength(1)
		expect(errors[0]!.message).toContain("--autonomous requires --timeout")
	})

	it("returns error when timeout is Infinity with autonomous", () => {
		const errors = validateAutonomousFlags({
			autonomous: true,
			print: true,
			workspace: "/path",
			timeout: Infinity,
		})
		expect(errors).toHaveLength(1)
		expect(errors[0]!.message).toContain("--autonomous requires --timeout")
	})

	it("accepts valid positive timeout values", () => {
		const validTimeouts = [1, 60, 300, 3600, 0.5, 1.5]
		validTimeouts.forEach((timeout) => {
			const errors = validateAutonomousFlags({
				autonomous: true,
				print: true,
				workspace: "/path",
				timeout,
			})
			expect(errors).toEqual([])
		})
	})

	it("returns multiple errors when multiple validations fail", () => {
		const errors = validateAutonomousFlags({
			autonomous: true,
			mode: "code",
			requireApproval: true,
			print: false,
			stdinPromptStream: true,
			// missing workspace and timeout
		})
		expect(errors.length).toBeGreaterThan(1)
		expect(errors.some((e) => e.message.includes("--mode"))).toBe(true)
		expect(errors.some((e) => e.message.includes("--require-approval"))).toBe(true)
		expect(errors.some((e) => e.message.includes("--print"))).toBe(true)
		expect(errors.some((e) => e.message.includes("--stdin-prompt-stream"))).toBe(true)
		expect(errors.some((e) => e.message.includes("--workspace"))).toBe(true)
		expect(errors.some((e) => e.message.includes("--timeout"))).toBe(true)
	})

	it("returns error when providerBaseUrl is used with non-openrouter provider in autonomous mode", () => {
		const errors = validateAutonomousFlags({
			autonomous: true,
			print: true,
			workspace: "/path",
			timeout: 300,
			providerBaseUrl: "https://custom.api",
			provider: "anthropic",
		})
		expect(errors).toHaveLength(1)
		expect(errors[0]!.message).toContain("--provider-base-url is currently supported only with --provider openrouter")
	})

	it("allows providerBaseUrl with openrouter provider in autonomous mode", () => {
		const errors = validateAutonomousFlags({
			autonomous: true,
			print: true,
			workspace: "/path",
			timeout: 300,
			providerBaseUrl: "https://custom.api",
			provider: "openrouter",
		})
		expect(errors).toEqual([])
	})
})

describe("validateProviderBaseUrl", () => {
	it("returns null when providerBaseUrl is not specified", () => {
		expect(validateProviderBaseUrl(undefined, "anthropic")).toBeNull()
		expect(validateProviderBaseUrl(undefined, "openrouter")).toBeNull()
		expect(validateProviderBaseUrl(undefined, undefined)).toBeNull()
	})

	it("returns null when providerBaseUrl is used with openrouter", () => {
		expect(validateProviderBaseUrl("https://custom.api", "openrouter")).toBeNull()
	})

	it("returns error when providerBaseUrl is used with anthropic", () => {
		const error = validateProviderBaseUrl("https://custom.api", "anthropic")
		expect(error).not.toBeNull()
		expect(error?.message).toContain("--provider-base-url is currently supported only with --provider openrouter")
	})

	it("returns error when providerBaseUrl is used with openai-native", () => {
		const error = validateProviderBaseUrl("https://custom.api", "openai-native")
		expect(error).not.toBeNull()
		expect(error?.message).toContain("--provider-base-url is currently supported only with --provider openrouter")
	})

	it("returns error when providerBaseUrl is used with gemini", () => {
		const error = validateProviderBaseUrl("https://custom.api", "gemini")
		expect(error).not.toBeNull()
		expect(error?.message).toContain("--provider-base-url is currently supported only with --provider openrouter")
	})

	it("returns error when providerBaseUrl is used without a provider", () => {
		const error = validateProviderBaseUrl("https://custom.api", undefined)
		expect(error).not.toBeNull()
		expect(error?.message).toContain("--provider-base-url is currently supported only with --provider openrouter")
	})
})
