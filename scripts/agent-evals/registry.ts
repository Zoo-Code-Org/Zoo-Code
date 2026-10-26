import { validateFixture, type AgentFixture } from "./contract.ts"

// Trusted in-memory registry. Fixtures enter only through validated
// registration from repo code. There is no file loading, no URL loading, and
// no dynamic import, so a registry name can never select untrusted content.
const fixtures = new Map<string, AgentFixture>()

export function registerFixture(fixture: AgentFixture): void {
	validateFixture(fixture)
	if (fixtures.has(fixture.identity.name)) throw new Error(`fixture already registered: ${fixture.identity.name}`)
	fixtures.set(fixture.identity.name, fixture)
}

export function getFixture(name: string): AgentFixture {
	const fixture = fixtures.get(name)
	if (!fixture) throw new Error(`unknown fixture: ${name}`)
	return fixture
}

export function listFixtures(): string[] {
	return [...fixtures.keys()].sort()
}
