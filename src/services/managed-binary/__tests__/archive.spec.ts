import { EventEmitter } from "events"
import * as path from "path"
import { PassThrough } from "stream"

import { spawn } from "child_process"

import {
	extractSingleFileTarXzArchive,
	extractSingleFileZipArchive,
	extractTarGzArchive,
	extractTarXzArchive,
	extractZipArchive,
	runProcess,
} from "../archive"

vi.mock("child_process", () => ({ spawn: vi.fn() }))

const mockSpawn = vi.mocked(spawn)

function decodePowerShellCommand(args: readonly string[]): string {
	const encodedCommandIndex = args.indexOf("-EncodedCommand")
	if (encodedCommandIndex === -1) throw new Error("Expected an encoded PowerShell command")
	return Buffer.from(args[encodedCommandIndex + 1], "base64").toString("utf16le")
}

function createChild() {
	return Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(),
	})
}

describe("managed binary archive utilities", () => {
	beforeEach(() => mockSpawn.mockReset())

	it("runs processes without a shell and returns their output", async () => {
		const child = createChild()
		mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>)
		const processResult = runProcess("tool", ["--version"])
		child.stdout.write("1.2.3")
		child.emit("close", 0)

		await expect(processResult).resolves.toEqual({ stdout: "1.2.3", stderr: "" })
		expect(mockSpawn).toHaveBeenCalledWith("tool", ["--version"], {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		})
	})

	it("kills a process that exceeds its timeout", async () => {
		vi.useFakeTimers()
		try {
			const child = createChild()
			mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>)
			const processResult = runProcess("tool", [], 100)
			const assertion = expect(processResult).rejects.toThrow("tool timed out")

			await vi.advanceTimersByTimeAsync(100)
			await assertion
			expect(child.kill).toHaveBeenCalledWith("SIGKILL")
		} finally {
			vi.useRealTimers()
		}
	})

	it("extracts tar.gz archives with hardened flags", async () => {
		const child = createChild()
		mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>)
		const extraction = extractTarGzArchive("/tmp/archive.tar.gz", "/tmp/output")
		child.emit("close", 0)
		await extraction

		expect(mockSpawn).toHaveBeenCalledWith(
			"tar",
			expect.arrayContaining(["-xzf", "/tmp/archive.tar.gz", "-C", "/tmp/output", "--no-same-owner"]),
			expect.objectContaining({ shell: false }),
		)
	})

	it("extracts tar.xz archives with hardened flags", async () => {
		const child = createChild()
		mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>)
		const extraction = extractTarXzArchive("/tmp/archive.tar.xz", "/tmp/output")
		child.emit("close", 0)
		await extraction

		const expectedArgs = ["-xJf", "/tmp/archive.tar.xz", "-C", "/tmp/output", "--no-same-owner"]
		if (process.platform === "linux") expectedArgs.push("--no-overwrite-dir")
		expect(mockSpawn).toHaveBeenCalledWith("tar", expectedArgs, {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		})
	})

	it("extracts ZIP archives with platform-safe process arguments", async () => {
		const child = createChild()
		mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>)
		const extraction = extractZipArchive("/tmp/archive.zip", "/tmp/output")
		child.emit("close", 0)
		await extraction

		if (process.platform === "win32") {
			expect(mockSpawn).toHaveBeenCalledWith(
				"powershell",
				["-NoProfile", "-NonInteractive", "-EncodedCommand", expect.any(String)],
				expect.objectContaining({ shell: false }),
			)
		} else {
			expect(mockSpawn).toHaveBeenCalledWith(
				"unzip",
				["-o", "/tmp/archive.zip", "-d", "/tmp/output"],
				expect.objectContaining({ shell: false }),
			)
		}
	})

	it("passes Windows ZIP paths through an encoded PowerShell command", async () => {
		const child = createChild()
		mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>)
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
		Object.defineProperty(process, "platform", { value: "win32", configurable: true })
		try {
			const extraction = extractZipArchive("C:\\Roo's files\\archive.zip", "C:\\Roo's files\\output")
			child.emit("close", 0)
			await extraction

			const args = mockSpawn.mock.calls[0][1]
			expect(args).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand", expect.any(String)])
			const script = decodePowerShellCommand(args)
			expect(script).toContain("$archivePath = 'C:\\Roo''s files\\archive.zip'")
			expect(script).toContain("$destination = 'C:\\Roo''s files\\output'")
			expect(script).toContain("Expand-Archive -LiteralPath $archivePath")
			expect(script).not.toContain("$args")
		} finally {
			if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
		}
	})

	it("validates a single-file tar.xz layout before extraction", async () => {
		const listing = createChild()
		const extraction = createChild()
		mockSpawn.mockReturnValueOnce(listing as unknown as ReturnType<typeof spawn>)
		mockSpawn.mockReturnValueOnce(extraction as unknown as ReturnType<typeof spawn>)
		const result = extractSingleFileTarXzArchive("/tmp/archive.tar.xz", "/tmp/output", "binary", "Tool")
		listing.stdout.write("-rwxr-xr-x user/group 1 2026-01-01 00:00 ./binary\n")
		listing.emit("close", 0)
		await new Promise<void>((resolve) => setImmediate(resolve))
		extraction.emit("close", 0)
		await result

		expect(mockSpawn).toHaveBeenNthCalledWith(
			2,
			"tar",
			[
				"-xJf",
				"/tmp/archive.tar.xz",
				"-C",
				"/tmp/output",
				"--no-same-owner",
				...(process.platform === "linux" ? ["--no-overwrite-dir"] : []),
				"./binary",
			],
			expect.any(Object),
		)
	})

	it.each([
		["-rwxr-xr-x user/group 1 2026-01-01 00:00 ./other\n", "an unexpected filename"],
		[
			"-rwxr-xr-x user/group 1 2026-01-01 00:00 ./binary\n-rwxr-xr-x user/group 1 2026-01-01 00:00 ./other\n",
			"multiple entries",
		],
		["lrwxrwxrwx user/group 0 2026-01-01 00:00 ./binary\n", "a non-regular entry"],
	])("rejects a tar.xz archive with %s", async (listingOutput) => {
		const listing = createChild()
		mockSpawn.mockReturnValue(listing as unknown as ReturnType<typeof spawn>)
		const result = extractSingleFileTarXzArchive("/tmp/archive.tar.xz", "/tmp/output", "binary", "Tool")
		listing.stdout.write(listingOutput)
		listing.emit("close", 0)

		await expect(result).rejects.toThrow("Tool archive has an unexpected layout")
	})

	it("builds a single-entry-validated PowerShell ZIP extraction", async () => {
		const child = createChild()
		mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>)
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
		Object.defineProperty(process, "platform", { value: "win32", configurable: true })
		try {
			const extraction = extractSingleFileZipArchive("C:\\archive.zip", "C:\\output", "binary.exe", "Tool")
			child.emit("close", 0)
			await extraction

			const args = mockSpawn.mock.calls[0][1]
			const script = decodePowerShellCommand(args)
			expect(script).toContain("$entries.Count -ne 1")
			expect(script).toContain("$archivePath = 'C:\\archive.zip'")
			expect(script).toContain(`$outputPath = '${path.join("C:\\output", "binary.exe")}'`)
			expect(args).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand", expect.any(String)])
		} finally {
			if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform)
		}
	})
})
