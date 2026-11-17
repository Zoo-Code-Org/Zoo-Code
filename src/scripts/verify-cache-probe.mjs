import assert from "node:assert/strict"
import { test } from "node:test"
import { stashCommit } from "./cache-probe.mjs"

test("stash commit probe rejects git failures and keeps the clean-tree fallback", () => {
	const cleanTree = () => ({ status: 0, stdout: "" })
	const dirtyTree = () => ({ status: 0, stdout: " M src/utils/path.ts\n" })
	const brokenTree = () => ({ status: 128, stdout: "", stderr: "fatal: unable to read the index" })
	const failures = [
		{ status: 128, stdout: "", stderr: "fatal: not a git repository", message: "fatal: not a git repository" },
		{ status: 2, stdout: "", stderr: "", message: "git exited with status 2" },
		{ status: 1, error: new Error("spawn failed"), stdout: "", stderr: "", message: "spawn failed" },
		{ status: 1, stdout: "", stderr: "stderr failure", message: "stderr failure" },
		{ status: null, error: new Error("spawn git ENOENT"), message: "spawn git ENOENT" },
		{ status: 1, signal: "SIGTERM", stdout: "", stderr: "", message: "SIGTERM" },
		{ status: 1, stdout: "unexpected output", stderr: "", message: "unexpected output" },
	]

	assert.equal(stashCommit({ status: 0, stdout: "0f53a1c\n" }, cleanTree), "0f53a1c")
	assert.equal(stashCommit({ status: 0, stdout: "\n" }, cleanTree), "HEAD")
	assert.equal(stashCommit({ status: 1, stdout: "", stderr: "" }, cleanTree), "HEAD")
	for (const result of failures) {
		assert.throws(() => stashCommit(result, cleanTree), { message: result.message })
	}
	assert.throws(
		() => stashCommit({ status: 1, stdout: "", stderr: "" }, dirtyTree),
		/git status reports tracked changes/,
	)
	assert.throws(
		() => stashCommit({ status: 1, stdout: "", stderr: "" }, brokenTree),
		/fatal: unable to read the index/,
	)
})
