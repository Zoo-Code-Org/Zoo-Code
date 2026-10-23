import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { comparePins, type SidePins } from "./coding-pins.ts"

const pins = (side: "baseline" | "candidate", overrides: Partial<SidePins> = {}): SidePins => ({
	side,
	commit: side === "baseline" ? "a".repeat(40) : "b".repeat(40),
	suiteId: "coding-basic-v1",
	suiteDigest: "d1".repeat(32),
	settingsDigest: "d2".repeat(32),
	modelIdentifier: "qwen3.8-27b",
	graderVersion: "coding-grader-v1",
	runnerEnvironment: { os: "linux", nodeVersion: "v22.23.1", vscodeTarget: "1.104.0" },
	...overrides,
})

describe("pinned comparison inputs", () => {
	it("accepts identical pins with different commits", () => {
		const result = comparePins(pins("baseline"), pins("candidate"))
		assert.equal(result.compatible, true)
		assert.deepEqual(result.differences, [])
	})

	it("flags each differing pinned value", () => {
		const cases: Partial<SidePins>[] = [
			{ suiteId: "coding-basic-v2" },
			{ suiteDigest: "zz".repeat(32) },
			{ settingsDigest: "zz".repeat(32) },
			{ modelIdentifier: "other-model" },
			{ graderVersion: "coding-grader-v2" },
			{ runnerEnvironment: { os: "darwin", nodeVersion: "v22.23.1", vscodeTarget: "1.104.0" } },
			{ runnerEnvironment: { os: "linux", nodeVersion: "v24.0.0", vscodeTarget: "1.104.0" } },
			{ runnerEnvironment: { os: "linux", nodeVersion: "v22.23.1", vscodeTarget: "1.100.0" } },
		]
		for (const overrides of cases) {
			const result = comparePins(pins("baseline"), pins("candidate", overrides))
			assert.equal(result.compatible, false, `expected incompatibility for ${JSON.stringify(overrides)}`)
			assert.ok(result.differences.length >= 1)
		}
	})

	it("never compares the commit SHAs themselves", () => {
		const result = comparePins(pins("baseline"), pins("candidate", { commit: "c".repeat(40) }))
		assert.equal(result.compatible, true)
	})
})
