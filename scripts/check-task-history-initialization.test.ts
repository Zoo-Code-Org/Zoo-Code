import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

for (const [mutation, retry] of [
	["resnapshot-active", "scan"],
	["resnapshot-migration", "migration"],
] as const) {
	test(`initialization checker rejects ${mutation}`, () => {
		const result = spawnSync(
			process.execPath,
			["--import", "tsx", "scripts/check-task-history-initialization.ts", `--mutation=${mutation}`],
			{ encoding: "utf8", timeout: 30_000 },
		)
		assert.ifError(result.error)
		assert.equal(result.status, 1, result.stderr)
		assert.match(result.stderr, /Initialization invariant: recovery must preserve repaired parents/)
		assert.match(result.stderr, /committed write \d+ parent=active/)
		assert.match(result.stderr, new RegExp(`${retry} 2:`))
		assert.match(result.stderr, /disk state changed across retries/)
	})
}
