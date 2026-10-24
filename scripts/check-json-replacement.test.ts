import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

for (const [mutation, invariant] of [
	["restore-backup-loss", 2],
	["delete-keeps-backup", 4],
	["reader-overwrites-newer", 6],
] as const) {
	test(`checker rejects ${mutation} with invariant ${invariant}`, () => {
		const result = spawnSync(
			process.execPath,
			["--import", "tsx", "scripts/check-json-replacement.ts", `--mutation=${mutation}`],
			{ encoding: "utf8", timeout: 30_000 },
		)
		assert.ifError(result.error)
		assert.equal(result.status, 1, result.stderr)
		assert.match(result.stderr, new RegExp(`JSON replacement invariant ${invariant}:`))
	})
}

for (const workers of ["0", "9", "1.5", "invalid"]) {
	test(`checker rejects invalid worker count ${workers}`, () => {
		const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/check-json-replacement.ts"], {
			encoding: "utf8",
			timeout: 30_000,
			env: { ...process.env, JSON_REPLACEMENT_WORKERS: workers },
		})
		assert.ifError(result.error)
		assert.equal(result.status, 1, result.stderr)
		assert.match(result.stderr, /JSON_REPLACEMENT_WORKERS must be an integer from 1 to 8/)
	})
}

for (const regression of ["rename-in-flight", "snapshot-race"]) {
	test(`accepts the deterministic ${regression} schedule`, () => {
		const result = spawnSync(
			process.execPath,
			["--import", "tsx", "scripts/check-json-replacement.ts", `--regression=${regression}`],
			{ encoding: "utf8", timeout: 30_000 },
		)
		assert.ifError(result.error)
		assert.equal(result.status, 0, result.stderr)
		assert.match(result.stdout, new RegExp(`${regression} regression passed`))
	})
}
