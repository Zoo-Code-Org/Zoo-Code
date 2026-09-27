// pnpm --filter roo-cline test core/task-persistence/__tests__/TaskHistoryLock.spec.ts

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

const { lockMock } = vi.hoisted(() => ({
	lockMock: vi.fn(),
}))

vi.mock("proper-lockfile", () => ({
	lock: lockMock,
}))

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
}))

import { TaskHistoryLock } from "../TaskHistoryLock"
import { GlobalFileNames } from "../../../shared/globalFileNames"
import { getStorageBasePath } from "../../../utils/storage"

function cumulativeRetryWindowMs(retries: {
	retries: number
	factor: number
	minTimeout: number
	maxTimeout: number
}): number {
	let total = 0
	for (let attempt = 0; attempt < retries.retries; attempt++) {
		total += Math.min(retries.maxTimeout, retries.minTimeout * retries.factor ** attempt)
	}
	return total
}

describe("TaskHistoryLock", () => {
	let tmpDir: string

	beforeEach(async () => {
		vi.clearAllMocks()
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "task-history-lock-"))
		lockMock.mockResolvedValue(vi.fn().mockResolvedValue(undefined))
	})

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	it("locks the shared tasks/_history.lock file and releases it after the callback", async () => {
		const taskHistoryLock = new TaskHistoryLock()
		const release = vi.fn().mockResolvedValue(undefined)
		lockMock.mockResolvedValueOnce(release)

		await expect(taskHistoryLock.withLock(tmpDir, async () => "done")).resolves.toBe("done")

		expect(lockMock).toHaveBeenCalledWith(
			path.join(tmpDir, "tasks", GlobalFileNames.historyLock),
			expect.any(Object),
		)
		expect(release).toHaveBeenCalledTimes(1)
	})

	it("keeps retrying long enough for proper-lockfile stale-lock recovery", async () => {
		const taskHistoryLock = new TaskHistoryLock()

		await taskHistoryLock.withLock(tmpDir, async () => undefined)

		const options = lockMock.mock.calls[0][1]
		expect(cumulativeRetryWindowMs(options.retries)).toBeGreaterThan(options.stale)
		expect(options).toMatchObject({
			stale: 31000,
			update: 10000,
			realpath: false,
			retries: { retries: 36, factor: 1, minTimeout: 1000, maxTimeout: 1000 },
		})
	})

	it("creates the tasks directory recursively when the storage root does not exist yet", async () => {
		const taskHistoryLock = new TaskHistoryLock()
		vi.mocked(getStorageBasePath).mockImplementationOnce(async (defaultPath: string) =>
			path.join(defaultPath, "nested", "base"),
		)

		await expect(taskHistoryLock.withLock(tmpDir, async () => "created")).resolves.toBe("created")

		const lockPath = lockMock.mock.calls[0][0]
		expect(lockPath).toBe(path.join(tmpDir, "nested", "base", "tasks", GlobalFileNames.historyLock))
	})

	it("surfaces a compromised lock instead of silently continuing", async () => {
		const taskHistoryLock = new TaskHistoryLock()
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)

		await taskHistoryLock.withLock(tmpDir, async () => undefined)
		const options = lockMock.mock.calls[0][1]

		expect(() => options.onCompromised(new Error("compromised"))).toThrow("compromised")
		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("[TaskHistoryLock]"), expect.any(Error))

		consoleErrorSpy.mockRestore()
	})
})
