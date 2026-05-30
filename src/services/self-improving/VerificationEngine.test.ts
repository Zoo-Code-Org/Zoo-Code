import { describe, it, expect, vi, beforeEach } from "vitest"
import { VerificationEngine } from "./VerificationEngine"

describe("VerificationEngine", () => {
	let engine: VerificationEngine
	let logger: { appendLine: ReturnType<typeof vi.fn> }

	beforeEach(() => {
		logger = { appendLine: vi.fn() }
		engine = new VerificationEngine(logger, {
			checkBuild: false,
			checkLint: false,
			checkTypes: false,
			checkTests: false,
			gateTimeoutMs: 5000,
			mandatory: true,
		})
	})

	describe("config", () => {
		it("should use defaults when no config provided", () => {
			const e = new VerificationEngine()
			const config = e.getConfig()
			expect(config.checkBuild).toBe(false)
			expect(config.checkLint).toBe(false)
			expect(config.checkTypes).toBe(false)
			expect(config.checkTests).toBe(false)
			expect(config.gateTimeoutMs).toBe(60000)
			expect(config.mandatory).toBe(true)
		})

		it("should merge partial config with defaults", () => {
			const e = new VerificationEngine(undefined, {
				checkBuild: true,
				buildCommand: "npm run build",
			})
			const config = e.getConfig()
			expect(config.checkBuild).toBe(true)
			expect(config.buildCommand).toBe("npm run build")
			expect(config.checkLint).toBe(false)
			expect(config.gateTimeoutMs).toBe(60000)
		})

		it("should update config via updateConfig", () => {
			engine.updateConfig({ checkLint: true, lintCommand: "npm run lint" })
			const config = engine.getConfig()
			expect(config.checkLint).toBe(true)
			expect(config.lintCommand).toBe("npm run lint")
		})
	})

	describe("verify with no gates", () => {
		it("should return passed=true with no gates configured", async () => {
			const result = await engine.verify()
			expect(result.passed).toBe(true)
			expect(result.gates).toHaveLength(0)
			expect(result.summary).toBe("No verification gates configured")
		})
	})

	describe("verify with gates", () => {
		it("should pass when all gates pass", async () => {
			engine.updateConfig({
				checkBuild: true,
				buildCommand: "echo build-ok",
				checkLint: true,
				lintCommand: "echo lint-ok",
				cwd: "/tmp",
			})

			const result = await engine.verify()
			expect(result.passed).toBe(true)
			expect(result.gates).toHaveLength(2)
			expect(result.gates[0].name).toBe("build")
			expect(result.gates[0].passed).toBe(true)
			expect(result.gates[1].name).toBe("lint")
			expect(result.gates[1].passed).toBe(true)
			expect(result.summary).toBe("All 2 verification gates passed")
		})

		it("should fail when build fails", async () => {
			engine.updateConfig({
				checkBuild: true,
				buildCommand: "false",
				cwd: "/tmp",
			})

			const result = await engine.verify()
			expect(result.passed).toBe(false)
			expect(result.gates).toHaveLength(1)
			expect(result.gates[0].name).toBe("build")
			expect(result.gates[0].passed).toBe(false)
			expect(result.gates[0].error).toBeTruthy()
			expect(result.summary).toContain("1/1 gates failed")
		})

		it("should fail when lint fails", async () => {
			engine.updateConfig({
				checkLint: true,
				lintCommand: "false",
				cwd: "/tmp",
			})

			const result = await engine.verify()
			expect(result.passed).toBe(false)
			expect(result.gates).toHaveLength(1)
			expect(result.gates[0].name).toBe("lint")
			expect(result.gates[0].passed).toBe(false)
		})

		it("should fail when type check fails", async () => {
			engine.updateConfig({
				checkTypes: true,
				typeCheckCommand: "false",
				cwd: "/tmp",
			})

			const result = await engine.verify()
			expect(result.passed).toBe(false)
			expect(result.gates).toHaveLength(1)
			expect(result.gates[0].name).toBe("type-check")
			expect(result.gates[0].passed).toBe(false)
		})

		it("should fail when tests fail", async () => {
			engine.updateConfig({
				checkTests: true,
				testCommand: "false",
				cwd: "/tmp",
			})

			const result = await engine.verify()
			expect(result.passed).toBe(false)
			expect(result.gates).toHaveLength(1)
			expect(result.gates[0].name).toBe("tests")
			expect(result.gates[0].passed).toBe(false)
		})

		it("should report multiple failures", async () => {
			engine.updateConfig({
				checkBuild: true,
				buildCommand: "false",
				checkLint: true,
				lintCommand: "false",
				cwd: "/tmp",
			})

			const result = await engine.verify()
			expect(result.passed).toBe(false)
			expect(result.gates).toHaveLength(2)
			expect(result.gates.every((g) => !g.passed)).toBe(true)
			expect(result.summary).toContain("2/2 gates failed")
		})

		it("should record duration for each gate", async () => {
			engine.updateConfig({
				checkBuild: true,
				buildCommand: "echo build-ok",
				cwd: "/tmp",
			})

			const result = await engine.verify()
			expect(result.gates).toHaveLength(1)
			expect(result.gates[0].durationMs).toBeGreaterThanOrEqual(0)
		})

		it("should timeout when command exceeds gateTimeoutMs", async () => {
			engine.updateConfig({
				checkBuild: true,
				buildCommand: "sleep 10",
				gateTimeoutMs: 100,
				cwd: "/tmp",
			})

			const result = await engine.verify()
			expect(result.passed).toBe(false)
			expect(result.gates[0].name).toBe("build")
			expect(result.gates[0].passed).toBe(false)
			expect(result.gates[0].error).toBeTruthy()
			// Gate should have failed due to timeout — error is present
			expect(result.gates[0].durationMs).toBeGreaterThanOrEqual(0)
		})
	})

	describe("mandatory flag", () => {
		it("should return mandatory=true by default", () => {
			expect(engine.getConfig().mandatory).toBe(true)
		})

		it("should allow setting mandatory=false", () => {
			engine.updateConfig({ mandatory: false })
			expect(engine.getConfig().mandatory).toBe(false)
		})
	})
})
