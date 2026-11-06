import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { AncestorReplacedError, safeWriteText, TargetMovedError, type AncestorIdentity } from "../safeWriteText"

// No fs mocks in this file: the point is to assert what a real filesystem ends up
// holding after a publish attempt, which the mocked spec cannot show. The failure is
// provoked with real filesystem semantics rather than with a stubbed call.
describe("safeWriteText against a real filesystem", () => {
	let dir: string

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "safe-write-text-int-"))
	})

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("publishes the new bytes and leaves no staging or backup residue", async () => {
		const targetPath = path.join(dir, "target.txt")
		await fs.writeFile(targetPath, "old bytes")

		// No platform override: the real platform's own durability and ACL steps run.
		// A failed icacls restore in a throwaway temp directory is reported, not thrown,
		// so the publish still lands.
		await safeWriteText(targetPath, "new bytes", { backup: true })

		expect(await fs.readFile(targetPath, "utf8")).toBe("new bytes")
		expect(await fs.readdir(dir)).toEqual(["target.txt"])
	})

	it("leaves the target bytes untouched when the backup copy of a directory target fails", async () => {
		// A directory target makes the backup COPY fail first (a directory cannot be
		// copied), so this covers the backup step, not the commit rename: the inner
		// catch unlinks the partial backup and rethrows before the rename runs.
		const targetPath = path.join(dir, "target-dir")
		await fs.mkdir(targetPath)
		const inside = path.join(targetPath, "payload.txt")
		await fs.writeFile(inside, "original bytes")

		await expect(safeWriteText(targetPath, "new data", { backup: true })).rejects.toThrow()

		// The directory and its content are exactly as they were, and no backup copy
		// or staging directory was left behind next to them.
		expect(await fs.readFile(inside, "utf8")).toBe("original bytes")
		expect(await fs.readdir(dir)).toEqual(["target-dir"])
	})

	it("leaves the target untouched when the commit rename itself cannot replace it", async () => {
		// backup:false makes the commit rename the first operation that touches the
		// target: a regular file cannot be renamed over a directory, so the failure
		// under test is the commit, and the cleanup is the temp unlink plus the
		// staging-directory removal.
		const targetPath = path.join(dir, "target-dir")
		await fs.mkdir(targetPath)
		const inside = path.join(targetPath, "payload.txt")
		await fs.writeFile(inside, "original bytes")

		await expect(safeWriteText(targetPath, "new data", { backup: false })).rejects.toThrow()

		// The directory and its content are exactly as they were, and neither the
		// staged temp nor the staging directory was left behind.
		expect(await fs.readFile(inside, "utf8")).toBe("original bytes")
		expect(await fs.readdir(dir)).toEqual(["target-dir"])
	})

	// ── authorized-path pins: what the caller decided is what gets published ──

	it("publishes when the pinned resolved path and ancestor identities still match", async () => {
		const scope = path.join(dir, "scope")
		const nested = path.join(scope, "nested")
		await fs.mkdir(nested, { recursive: true })
		const targetPath = path.join(nested, "target.txt")
		await fs.writeFile(targetPath, "old bytes")

		// Exactly what safeWriteJson records: the resolved target plus the identity of every
		// directory it walked, as canonical paths.
		const identities: AncestorIdentity[] = []
		for (const candidate of [await fs.realpath(scope), await fs.realpath(nested)]) {
			const stat = await fs.stat(candidate, { bigint: true })
			identities.push({ dir: candidate, dev: stat.dev, ino: stat.ino })
		}

		await safeWriteText(targetPath, "new bytes", {
			expectedResolvedPath: await fs.realpath(targetPath),
			expectedAncestorIdentities: identities,
		})

		// The pins do not turn an unchanged chain into a rejection: the publish lands and
		// leaves no staging, backup or temporary residue beside it.
		expect(await fs.readFile(targetPath, "utf8")).toBe("new bytes")
		expect(await fs.readdir(nested)).toEqual(["target.txt"])
	})

	it("refuses to publish when the target no longer resolves to the authorized path", async () => {
		const targetPath = path.join(dir, "target.txt")
		await fs.writeFile(targetPath, "old bytes")
		const authorized = path.join(dir, "other.txt")

		// The caller authorized a different resolved path: publishing here would act on a
		// decision that was never made about this file.
		const error = await safeWriteText(targetPath, "new bytes", { expectedResolvedPath: authorized }).then(
			() => undefined,
			(reason: unknown) => reason,
		)

		expect(error).toBeInstanceOf(TargetMovedError)
		expect((error as TargetMovedError).authorizedPath).toBe(authorized)
		expect((error as TargetMovedError).resolvedPath).toBe(await fs.realpath(targetPath))
		// Nothing was staged or published, and the existing bytes are untouched.
		expect(await fs.readFile(targetPath, "utf8")).toBe("old bytes")
		expect(await fs.readdir(dir)).toEqual(["target.txt"])
	})

	it("refuses the commit when an authorized ancestor directory was replaced", async () => {
		const ancestor = path.join(dir, "settings")
		await fs.mkdir(ancestor)
		const targetPath = path.join(ancestor, "target.txt")
		await fs.writeFile(targetPath, "old bytes")
		// The canonical name and identity the caller walked, before the swap.
		const authorizedDir = await fs.realpath(ancestor)
		const authorized = await fs.stat(authorizedDir, { bigint: true })

		// Replace the directory between the caller's decision and the commit. The name still
		// exists and still resolves to itself - only the directory under it is a different one.
		const replaced = ancestor + "-replaced"
		await fs.rename(ancestor, replaced)
		await fs.mkdir(ancestor)

		const error = await safeWriteText(targetPath, "new bytes", {
			expectedAncestorIdentities: [{ dir: authorizedDir, dev: authorized.dev, ino: authorized.ino }],
		}).then(
			() => undefined,
			(reason: unknown) => reason,
		)

		// Fail closed with the replaced directory named, not with a cleanup or staging error:
		// the staged temp and this write's staging directory are removed before it is thrown.
		expect(error).toBeInstanceOf(AncestorReplacedError)
		expect((error as AncestorReplacedError).directory).toBe(authorizedDir)
		expect((error as AncestorReplacedError).message).toContain("no longer the directory that was authorized")
		// Nothing was published into the replacement directory, and nothing leaked into it.
		expect(await fs.readdir(ancestor)).toEqual([])
		// The directory that was moved aside still holds its pre-write bytes.
		expect(await fs.readFile(path.join(replaced, "target.txt"), "utf8")).toBe("old bytes")
	})

	it("refuses the commit when an authorized ancestor is moved and its name links to the moved copy", async () => {
		const ancestor = path.join(dir, "linked")
		await fs.mkdir(ancestor)
		const targetPath = path.join(ancestor, "target.txt")
		const authorizedDir = await fs.realpath(ancestor)
		const authorized = await fs.stat(authorizedDir, { bigint: true })

		// A move preserves (dev, ino), and the link left at the old name makes stat() follow it,
		// so the identity check alone matches. The name no longer resolves to the location the
		// caller walked, and the commit below takes path strings - it would follow the link.
		const moved = ancestor + "-moved"
		await fs.rename(ancestor, moved)
		await fs.symlink(moved, ancestor, process.platform === "win32" ? "junction" : "dir")

		const error = await safeWriteText(targetPath, "new bytes", {
			expectedAncestorIdentities: [{ dir: authorizedDir, dev: authorized.dev, ino: authorized.ino }],
		}).then(
			() => undefined,
			(reason: unknown) => reason,
		)

		expect(error).toBeInstanceOf(AncestorReplacedError)
		expect((error as AncestorReplacedError).message).toContain("no longer resolves to the authorized location")
		// Nothing was published through the link, and the staged temp was removed from it.
		expect(await fs.readdir(moved)).toEqual([])
	})
})
