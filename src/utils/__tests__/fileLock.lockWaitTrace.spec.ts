// npx vitest run utils/__tests__/fileLock.lockWaitTrace.spec.ts

import * as path from "path"

import * as lockfile from "proper-lockfile"

import { tracePersistenceEvent } from "../../core/task-persistence/persistenceTrace"
import { acquireFileLock, withFileLock } from "../fileLock"

vi.mock("proper-lockfile", () => ({
	lock: vi.fn(async () => async () => {}),
}))

vi.mock("../../core/task-persistence/persistenceTrace", () => ({
	tracePersistenceEvent: vi.fn(),
}))

vi.mock("fs/promises", () => ({
	// The canonical route is mocked to move the parent, so the key the trace names is distinguishable
	// from the spelling the caller arrived with.
	realpath: vi.fn(async (target: unknown) => String(target).replace("aliasDir", "realDir")),
	readlink: vi.fn(async () => {
		throw Object.assign(new Error("EINVAL: not a symlink"), { code: "EINVAL" })
	}),
}))

/**
 * Both lock-wait trace calls were code no test executed. The mutation run reported the event name,
 * the payload object and both `waitForStaleLock` conditions as survivors on the acquisition helper
 * and on `withFileLock`, which is only possible when the waiting path was never taken and the
 * waiting-free path was never checked for staying silent. Each pair below pins the event on one
 * path and its absence on the other, so tracing always and tracing never both fail.
 *
 * The traced value is read back from the acquisition the code actually made instead of spelled out:
 * canonical spellings belong to the volume, and this row is about which event carries which field.
 */
const STORE = path.resolve("/tmp/store")
const aliasPath = path.join(STORE, "aliasDir", "task.json")

function tracedPayloads(): unknown[] {
	return vi.mocked(tracePersistenceEvent).mock.calls.map((call) => call[1])
}

describe("fileLock lock-wait trace", () => {
	beforeEach(() => {
		vi.mocked(lockfile.lock).mockReset()
		vi.mocked(tracePersistenceEvent).mockClear()
	})

	test("emits the lock-wait event with the canonical key acquireFileLock is about to take", async () => {
		const releaseLock = await acquireFileLock(aliasPath, { waitForStaleLock: true })
		const canonicalKey = String(vi.mocked(lockfile.lock).mock.calls[0]?.[0])

		expect(tracePersistenceEvent).toHaveBeenCalledTimes(1)
		expect(tracePersistenceEvent).toHaveBeenCalledWith("json-lock-wait", { filePath: canonicalKey })
		// the traced path is the key the lock is taken on, not the spelling the caller arrived with
		expect(tracedPayloads()).toEqual([{ filePath: canonicalKey }])
		expect(canonicalKey).not.toBe(aliasPath)

		await releaseLock()
	})

	test("emits nothing on the acquireFileLock path that does not wait for a stale lock", async () => {
		const releaseLock = await acquireFileLock(aliasPath)

		expect(lockfile.lock).toHaveBeenCalledTimes(1)
		expect(tracePersistenceEvent).not.toHaveBeenCalled()

		await releaseLock()
	})

	test("emits the lock-wait event with the canonical key withFileLock is about to take", async () => {
		const seen: string[] = []
		await withFileLock(
			aliasPath,
			async (absoluteFilePath) => {
				seen.push(absoluteFilePath)
			},
			{ waitForStaleLock: true },
		)
		const canonicalKey = String(vi.mocked(lockfile.lock).mock.calls[0]?.[0])

		expect(tracePersistenceEvent).toHaveBeenCalledTimes(1)
		expect(tracePersistenceEvent).toHaveBeenCalledWith("json-lock-wait", { filePath: canonicalKey })
		expect(tracedPayloads()).toEqual([{ filePath: canonicalKey }])
		expect(seen).toEqual([aliasPath])
	})

	test("emits nothing on the withFileLock path that does not wait for a stale lock", async () => {
		await withFileLock(aliasPath, async () => "written")

		expect(lockfile.lock).toHaveBeenCalledTimes(1)
		expect(tracePersistenceEvent).not.toHaveBeenCalled()
	})
})
