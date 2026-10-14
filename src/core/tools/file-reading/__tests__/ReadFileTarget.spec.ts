import * as fs from "fs/promises"

import { ReadFileCancellation } from "../ReadFileCancellation"
import { ReadFileCancelledError } from "../ReadFileCancelledError"
import { ReadFileTarget } from "../ReadFileTarget"

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return { ...actual, realpath: vi.fn(), lstat: vi.fn(), open: vi.fn() }
})

describe("ReadFileTarget resolution errors", () => {
	beforeEach(() => vi.clearAllMocks())

	it("preserves an existing cancellation error without replacing it in the target's catch", async () => {
		const task = { abort: false, abandoned: false }
		const cancellation = new ReadFileCancellation(task)
		const error = new ReadFileCancelledError()
		const check = vi.spyOn(cancellation, "throwIfCancelled")
		vi.mocked(fs.realpath).mockImplementationOnce(async () => {
			task.abort = true
			throw error
		})

		await expect(ReadFileTarget.resolve("/workspace/file.txt", cancellation)).rejects.toBe(error)
		expect(check).toHaveBeenCalledOnce()
		expect(fs.lstat).not.toHaveBeenCalled()
	})

	it("does not defer a cancellation error even if it carries a filesystem-like code", async () => {
		const cancellation = new ReadFileCancellation({ abort: false, abandoned: false })
		const error = Object.assign(new ReadFileCancelledError(), { code: "ECANCELED" })
		vi.mocked(fs.realpath).mockRejectedValueOnce(error)

		await expect(ReadFileTarget.resolve("/workspace/file.txt", cancellation)).rejects.toBe(error)
		expect(fs.lstat).not.toHaveBeenCalled()
	})

	it.each(["abort", "abandoned"] as const)(
		"does not defer a late filesystem error when %s changes during resolution",
		async (flag) => {
			const task = { abort: false, abandoned: false }
			const cancellation = new ReadFileCancellation(task)
			vi.mocked(fs.realpath).mockImplementationOnce(async () => {
				task[flag] = true
				throw Object.assign(new Error("late missing file"), { code: "ENOENT" })
			})

			await expect(ReadFileTarget.resolve("/workspace/file.txt", cancellation)).rejects.toBeInstanceOf(
				ReadFileCancelledError,
			)
			expect(fs.lstat).not.toHaveBeenCalled()
		},
	)

	it("keeps ordinary filesystem diagnostics deferred until approved handle access", async () => {
		const cancellation = new ReadFileCancellation({ abort: false, abandoned: false })
		const error = Object.assign(new Error("missing file"), { code: "ENOENT" })
		vi.mocked(fs.realpath).mockRejectedValueOnce(error)
		const read = vi.fn(async () => "unexpected content")

		const target = await ReadFileTarget.resolve("/workspace/file.txt", cancellation)

		expect(target.fullPath).toBe("/workspace/file.txt")
		await expect(target.withHandle(read)).rejects.toBe(error)
		expect(fs.open).not.toHaveBeenCalled()
		expect(read).not.toHaveBeenCalled()
	})
})
