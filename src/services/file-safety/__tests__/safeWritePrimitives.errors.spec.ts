// The three classes below are raised by the primitives commit path. The JSON layer imports
// them only to re-name a fault it did not raise (see the _publishFault doc comment in
// src/utils/safeWriteJson.ts), so no caller in this tree constructs them yet: their names,
// their messages and the fields they carry are observable only by building them. These tests
// build them, so the next caller that reads a name or a stage-specific sentence is reading
// something that was checked rather than something that was never run.

import { PostCommitDurabilityError, StagingPathError, StagingReplacedError } from "../safeWritePrimitives"

describe("StagingPathError", () => {
	it("names itself and carries the rejected staging path", () => {
		const error = new StagingPathError("staging path is outside the target directory", "/tmp/x/.zdt-stage-1")
		expect(error).toBeInstanceOf(Error)
		expect(error.name).toBe("StagingPathError")
		expect(error.stagingPath).toBe("/tmp/x/.zdt-stage-1")
		expect(error.message).toBe("staging path is outside the target directory")
	})
})

describe("PostCommitDurabilityError", () => {
	it("names itself, carries both paths, keeps the fsync failure as its cause, and states the claim it makes", () => {
		const cause = Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" })
		const error = new PostCommitDurabilityError("/tmp/x/mcp.json", cause, "/tmp/x/.zdt-backup-1")
		expect(error.name).toBe("PostCommitDurabilityError")
		expect(error.targetPath).toBe("/tmp/x/mcp.json")
		expect(error.backupPath).toBe("/tmp/x/.zdt-backup-1")
		expect(error.cause).toBe(cause)
		// The sentence is the contract: the rename landed, the directory entry is what failed.
		// A caller that reports this as a lost write tells the user the opposite of what happened.
		expect(error.message).toContain("The rename committed")
		expect(error.message).toContain("parent directory could not be fsynced")
		expect(error.message).toContain("directory entry may not be durable")
	})
	it("reports no retained copy when backup mode left none", () => {
		const error = new PostCommitDurabilityError("/tmp/x/mcp.json", new Error("EIO: i/o error, fsync"))
		expect(error.backupPath).toBeNull()
	})
})

describe("StagingReplacedError", () => {
	it("says the commit was skipped when the swap was noticed before the commit rename", () => {
		const error = new StagingReplacedError("/tmp/x/.zdt-stage-1", "before-commit", "/tmp/x/mcp.json", null)
		expect(error.name).toBe("StagingReplacedError")
		expect(error.stage).toBe("before-commit")
		expect(error.stagingPath).toBe("/tmp/x/.zdt-stage-1")
		expect(error.targetPath).toBe("/tmp/x/mcp.json")
		expect(error.backupPath).toBeNull()
		expect(error.message).toContain("/tmp/x/.zdt-stage-1")
		expect(error.message).toContain("no longer names the file this write staged")
		expect(error.message).toContain("the target was left as it was")
		// The after-commit sentence would claim a publish this write never made.
		expect(error.message).not.toContain("did not stage")
	})
	it("says the target holds a foreign file when the swap was noticed after the commit rename", () => {
		const error = new StagingReplacedError(
			"/tmp/x/.zdt-stage-1",
			"after-commit",
			"/tmp/x/mcp.json",
			"/tmp/x/.zdt-backup-1",
		)
		expect(error.stage).toBe("after-commit")
		expect(error.message).toContain("was replaced before the commit rename landed")
		expect(error.message).toContain("a file this write did not stage")
		expect(error.message).not.toContain("left as it was")
		expect(error.backupPath).toBe("/tmp/x/.zdt-backup-1")
	})
})
