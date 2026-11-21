import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { getFixture, listFixtures, registerFixture } from "./registry.ts"
import { buildSmokeFixture, ensureSmokeFixtureRegistered, SMOKE_FIXTURE_NAME } from "../solheim-smoke/fixture.ts"

describe("trusted fixture registry", () => {
	it("registers, lists, and returns the smoke fixture by exact name", () => {
		ensureSmokeFixtureRegistered()
		assert.ok(listFixtures().includes(SMOKE_FIXTURE_NAME))
		assert.equal(getFixture(SMOKE_FIXTURE_NAME).identity.name, SMOKE_FIXTURE_NAME)
	})

	it("rejects duplicate registration and unknown names", () => {
		assert.throws(() => registerFixture(buildSmokeFixture()), /already registered/)
		assert.throws(() => getFixture("does-not-exist"), /unknown fixture/)
	})

	it("validates fixtures at the registry boundary", () => {
		const broken = buildSmokeFixture()
		const invalid = { ...broken, identity: { ...broken.identity, name: "UPPER" } }
		assert.throws(() => registerFixture(invalid), /name/)
	})
})
