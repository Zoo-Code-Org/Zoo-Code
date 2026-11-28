import * as path from "path"
import * as lockfile from "proper-lockfile"
import { acquireFileLock } from "../fileLock"

vi.mock("proper-lockfile", () => ({ lock: vi.fn() }))

it("queues same-process writes to one file without blocking other files", async () => {
	const held = new Set<string>()
	vi.mocked(lockfile.lock).mockImplementation(async (filePath) => {
		const file = path.resolve(filePath)
		if (held.has(file)) throw new Error("Lock file is already being held")
		held.add(file)
		return async () => {
			held.delete(file)
		}
	})

	const firstPath = path.resolve("first-ui-messages.json")
	const secondPath = path.resolve("second-ui-messages.json")
	const releaseFirst = await acquireFileLock(firstPath)
	const second = acquireFileLock(firstPath)
	await Promise.resolve()
	await Promise.resolve()
	expect(lockfile.lock).toHaveBeenCalledOnce()
	// Upstream startup recovery must defer immediately instead of parking on
	// our same-process writer queue while holding the task-store mutex.
	await expect(acquireFileLock(firstPath, { immediate: true })).rejects.toMatchObject({ code: "ELOCKED" })
	expect(lockfile.lock).toHaveBeenCalledOnce()

	const releaseOther = await acquireFileLock(secondPath)
	expect(lockfile.lock).toHaveBeenCalledTimes(2)
	await releaseOther()
	await releaseFirst()
	const releaseSecond = await second
	expect(lockfile.lock).toHaveBeenCalledTimes(3)
	await releaseSecond()

	const releaseAfter = await acquireFileLock(firstPath)
	await releaseAfter()
	expect(held.size).toBe(0)
})
