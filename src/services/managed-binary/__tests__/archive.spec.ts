import { EventEmitter } from "events"
import { PassThrough } from "stream"

import { spawn } from "child_process"

import {
	escapePowerShellLiteral,
	extractSingleFileTarXzArchive,
	extractSingleFileZipArchive,
	extractTarGzArchive,
	runProcess,
} from "../archive"

vi.mock("child_process", () => ({ spawn: vi.fn() }))

const mockSpawn = vi.mocked(spawn)

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

	it("escapes PowerShell single-quoted literals", () => {
		expect(escapePowerShellLiteral("C:\\it's\\archive.zip")).toBe("C:\\it''s\\archive.zip")
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

	it("validates a single-file tar.xz layout before extraction", async () => {
		const listing = createChild()
		const extraction = createChild()
		mockSpawn.mockReturnValueOnce(listing as unknown as ReturnType<typeof spawn>)
		mockSpawn.mockReturnValueOnce(extraction as unknown as ReturnType<typeof spawn>)
		const result = extractSingleFileTarXzArchive("/tmp/archive.tar.xz", "/tmp/output", "binary", "Tool")
		listing.stdout.write("./binary\n")
		listing.emit("close", 0)
		await new Promise<void>((resolve) => setImmediate(resolve))
		extraction.emit("close", 0)
		await result

		expect(mockSpawn).toHaveBeenNthCalledWith(
			2,
			"tar",
			["-xJf", "/tmp/archive.tar.xz", "-C", "/tmp/output", "binary"],
			expect.any(Object),
		)
	})

	it("builds a single-entry-validated PowerShell ZIP extraction", async () => {
		const child = createChild()
		mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>)
		const extraction = extractSingleFileZipArchive("C:\\archive.zip", "C:\\output", "binary.exe", "Tool")
		child.emit("close", 0)
		await extraction

		const script = mockSpawn.mock.calls[0][1][3]
		expect(script).toContain("$entries.Count -ne 1")
		expect(script).toContain("binary.exe")
		expect(script).toContain("Tool archive has an unexpected layout")
	})
})
