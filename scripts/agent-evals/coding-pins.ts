export interface SidePins {
	side: "baseline" | "candidate"
	commit: string
	suiteId: string
	suiteDigest: string
	settingsDigest: string
	modelIdentifier: string
	graderVersion: string
	// Immutable grader image identity resolved from the local engine, for
	// example a repo digest. The value "unavailable" records that no identity
	// was resolvable; it is never a fabricated digest.
	graderImageDigest: string
	runnerEnvironment: {
		os: string
		nodeVersion: string
		vscodeTarget: string
	}
}

export interface PinComparison {
	compatible: boolean
	differences: string[]
}

// Pinned comparison inputs. The two commit SHAs differ by design and are
// recorded, never compared. Every other pinned value must match on both
// sides; any difference marks the pair incompatible.
const COMPARED_FIELDS = [
	"suiteId",
	"suiteDigest",
	"settingsDigest",
	"modelIdentifier",
	"graderVersion",
	"graderImageDigest",
] as const

export function comparePins(baseline: SidePins, candidate: SidePins): PinComparison {
	const differences: string[] = []
	for (const field of COMPARED_FIELDS) if (baseline[field] !== candidate[field]) differences.push(field)
	const envFields = ["os", "nodeVersion", "vscodeTarget"] as const
	for (const field of envFields)
		if (baseline.runnerEnvironment[field] !== candidate.runnerEnvironment[field])
			differences.push(`runnerEnvironment.${field}`)
	return { compatible: differences.length === 0, differences }
}

// A side cannot publish a single image pin for runs graded with different images.
export function sideGraderImageDigest(runs: readonly { graderImageDigest?: string }[]): string {
	const digests = new Set(runs.flatMap((run) => (run.graderImageDigest === undefined ? [] : [run.graderImageDigest])))
	if (digests.size > 1) throw new Error("grader image digest changed within the side")
	return digests.values().next().value ?? "unavailable"
}
