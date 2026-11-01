import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { FixtureValidationError, validateFixture, validateWorkspaceFilePath } from "./contract.ts"
import { buildSmokeFixture } from "../solheim-smoke/fixture.ts"
import { buildSmokeConfiguration, SMOKE_PROMPT } from "../solheim-smoke/config.ts"

const expectFailure = (run: () => void, pattern: RegExp): void => {
	assert.throws(run, (error: unknown) => error instanceof FixtureValidationError && pattern.test(error.message))
}

describe("agent fixture contract", () => {
	it("accepts the registered smoke fixture", () => {
		validateFixture(buildSmokeFixture())
	})

	it("rejects malformed identity, prompt, and workspace declarations", () => {
		const base = buildSmokeFixture()
		expectFailure(() => validateFixture({ ...base, identity: { ...base.identity, name: "Bad Name" } }), /name/)
		expectFailure(() => validateFixture({ ...base, identity: { ...base.identity, version: "1.0" } }), /version/)
		expectFailure(() => validateFixture({ ...base, prompt: "" }), /prompt/)
		expectFailure(
			() => validateFixture({ ...base, workspace: { files: [{ path: "../escape.txt", content: "x" }] } }),
			/segments/,
		)
		expectFailure(
			() => validateFixture({ ...base, workspace: { files: [{ path: "/etc/passwd", content: "x" }] } }),
			/relative/,
		)
		expectFailure(
			() => validateFixture({ ...base, workspace: { files: [{ path: "a\\b.txt", content: "x" }] } }),
			/forward slashes/,
		)
		expectFailure(
			() => validateFixture({ ...base, workspace: { files: [{ path: "C:run.txt", content: "x" }] } }),
			/drive letter/,
		)
		expectFailure(
			() =>
				validateFixture({ ...base, workspace: { files: [{ path: "big.txt", content: "x".repeat(16_385) }] } }),
			/too large/,
		)
	})

	it("rejects missing limits, non-boolean allowances, and hook-shaped builders", () => {
		const base = buildSmokeFixture()
		const limits = { ...base.limits }
		delete (limits as Partial<typeof limits>)["taskRunTimeoutMs"]
		expectFailure(() => validateFixture({ ...base, limits: limits as typeof base.limits }), /taskRunTimeoutMs/)
		expectFailure(() => validateFixture({ ...base, limits: { ...base.limits, taskRunTimeoutMs: 0 } }), /positive/)
		expectFailure(
			() => validateFixture({ ...base, limits: { ...base.limits, taskRunTimeoutMs: 601_000 } }),
			/within bounds/,
		)
		const allow = { ...base.toolPolicy.allow }
		delete (allow as Partial<typeof allow>)["execute"]
		expectFailure(
			() => validateFixture({ ...base, toolPolicy: { ...base.toolPolicy, allow: allow as typeof allow } }),
			/execute/,
		)
		expectFailure(
			() =>
				validateFixture({
					...base,
					toolPolicy: { ...base.toolPolicy, disabledTools: [] },
				}),
			/disable at least one tool/,
		)
		const broken = buildSmokeFixture() as unknown as Record<string, unknown>
		broken["buildConfiguration"] = "not a function"
		expectFailure(() => validateFixture(broken as unknown as typeof base), /builder/)
	})

	it("keeps the smoke projection in sync with the built configuration and free of credentials", () => {
		const fixture = buildSmokeFixture()
		const credential = "sk-live-credential"
		assert.equal(fixture.prompt, SMOKE_PROMPT)
		assert.equal(fixture.buildConfiguration, buildSmokeConfiguration)
		const config = buildSmokeConfiguration(credential)
		for (const [key, value] of Object.entries(fixture.settingsProjection)) {
			const expected =
				key === "openAiExtraBody"
					? JSON.parse(config.openAiExtraBody ?? "null")
					: config[key as keyof typeof config]
			assert.deepEqual(value, expected, `projection key ${key} drifts from the built configuration`)
		}
		assert.ok(!Object.keys(fixture.settingsProjection).includes("openAiApiKey"))
		assert.ok(!JSON.stringify(fixture.settingsProjection).includes(credential))
	})

	it("bounds workspace file paths at the contract layer", () => {
		validateWorkspaceFilePath("docs/readme.md")
		validateWorkspaceFilePath("src/nested/deep/file.ts")
		expectFailure(() => validateWorkspaceFilePath(".."), /segments/)
		expectFailure(() => validateWorkspaceFilePath("a/./b"), /segments/)
		expectFailure(() => validateWorkspaceFilePath("a//b"), /segments/)
		expectFailure(() => validateWorkspaceFilePath(""), /missing/)
		expectFailure(() => validateWorkspaceFilePath(`a/${"x".repeat(300)}`), /out of bounds/)
	})
})
