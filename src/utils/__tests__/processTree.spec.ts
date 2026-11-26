import type { ExecFileOptions } from "node:child_process"

type Runner = (
	file: string,
	args: string[],
	options: ExecFileOptions,
	callback: (error: Error | null, stdout: string) => void,
) => void
const mocks = vi.hoisted(() => ({ execFile: vi.fn<Runner>() }))
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }))

import { descendantsOf, getChildProcesses, parseProcessSnapshot } from "../processTree"

describe("bounded process snapshots", () => {
	beforeEach(() => {
		mocks.execFile.mockReset()
	})

	it("uses CIM with a bounded, handled child process instead of WMIC", async () => {
		mocks.execFile.mockImplementation((_file, _args, _options, callback) =>
			callback(null, '[{"ProcessId":30,"ParentProcessId":20},{"ProcessId":20,"ParentProcessId":10}]'),
		)
		await expect(getChildProcesses(10, "win32")).resolves.toEqual([
			{ pid: 20, parentPid: 10 },
			{ pid: 30, parentPid: 20 },
		])
		const [file, args, options] = mocks.execFile.mock.calls[0]
		expect(file).toMatch(/powershell\.exe$/i)
		expect(args).toContain("-NonInteractive")
		expect(args.at(-1)).toContain("Get-CimInstance")
		expect(args.join(" ")).not.toContain("wmic")
		expect(options).toMatchObject({ timeout: 5_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
	})

	it("uses the PID-only ps format on Unix", async () => {
		mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, " 1 10\n 10 20\n"))
		await expect(getChildProcesses(10, "linux")).resolves.toEqual([{ pid: 20, parentPid: 10 }])
		expect(mocks.execFile.mock.calls[0].slice(0, 2)).toEqual(["ps", ["-A", "-o", "ppid=,pid="]])
	})

	it.each(["ENOENT", "ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"])(
		"rejects %s through the callback rather than emitting an unhandled process error",
		async (code) => {
			const error = Object.assign(new Error(code), { code })
			mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(error, ""))
			await expect(getChildProcesses(10, "win32")).rejects.toBe(error)
		},
	)

	it("handles PowerShell's single-row and empty JSON shapes and rejects malformed snapshots", () => {
		expect(parseProcessSnapshot('\uFEFF{"ProcessId":2,"ParentProcessId":1}', "win32")).toEqual([
			{ pid: 2, parentPid: 1 },
		])
		expect(parseProcessSnapshot("null", "win32")).toEqual([])
		expect(parseProcessSnapshot("", "win32")).toEqual([])
		expect(() => parseProcessSnapshot("not JSON", "win32")).toThrow()
		expect(
			parseProcessSnapshot(
				'[{"ProcessId":-1,"ParentProcessId":1},{"ProcessId":"bad","ParentProcessId":1}]',
				"win32",
			),
		).toEqual([])
		expect(parseProcessSnapshot("header pid\n 1 NaN\n 1 -2\n", "linux")).toEqual([])
	})

	it("handles cycles, duplicates, unrelated processes and arbitrarily ordered descendants", () => {
		expect(
			descendantsOf(10, [
				{ pid: 30, parentPid: 20 },
				{ pid: 20, parentPid: 10 },
				{ pid: 20, parentPid: 10 },
				{ pid: 10, parentPid: 30 },
				{ pid: 40, parentPid: 40 },
				{ pid: 50, parentPid: 1 },
			]),
		).toEqual([
			{ pid: 20, parentPid: 10 },
			{ pid: 30, parentPid: 20 },
		])
	})

	it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid root PID %s", async (pid) => {
		await expect(getChildProcesses(pid)).rejects.toThrow("Invalid process ID")
		expect(mocks.execFile).not.toHaveBeenCalled()
	})
})
