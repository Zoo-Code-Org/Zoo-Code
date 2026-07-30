import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import * as path from "path"

import { ensureManagedBinaryInstalled, getManagedBinaryPaths, type ManagedBinaryInstallOptions } from "../install"

describe("managed binary installation", () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "managed-binary-"))
	})

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true })
	})

	function createOptions(overrides: Partial<ManagedBinaryInstallOptions> = {}): ManagedBinaryInstallOptions {
		return {
			storageDir: tempDir,
			id: "example",
			version: "v1.2.3",
			versionFile: ".example-version",
			archiveName: "example.tar.gz",
			binaryName: "example",
			download: vi.fn(),
			verifyArchive: vi.fn(),
			extractArchive: vi.fn(),
			...overrides,
		}
	}

	it("derives one consistent mutable installation layout", () => {
		expect(getManagedBinaryPaths(createOptions())).toEqual({
			installRoot: path.join(tempDir, "example"),
			binaryPath: path.join(tempDir, "example", "example"),
			versionPath: path.join(tempDir, "example", ".example-version"),
			stagingDir: path.join(tempDir, "example.new"),
			stagedBinaryPath: path.join(tempDir, "example.new", "example"),
			archivePath: path.join(tempDir, "v1.2.3-example.tar.gz"),
		})
	})

	it("reuses a current executable without invoking update callbacks", async () => {
		const options = createOptions()
		const paths = getManagedBinaryPaths(options)
		await mkdir(paths.installRoot, { recursive: true })
		await writeFile(paths.binaryPath, "current")
		await writeFile(paths.versionPath, options.version)
		if (process.platform !== "win32") await chmod(paths.binaryPath, 0o600)

		await expect(ensureManagedBinaryInstalled(options)).resolves.toBe(paths.binaryPath)
		expect(options.download).not.toHaveBeenCalled()
	})

	it("deduplicates concurrent installations", () => {
		const options = createOptions({ download: () => new Promise<void>(() => {}) })
		expect(ensureManagedBinaryInstalled(options)).toBe(ensureManagedBinaryInstalled(options))
	})

	it("coordinates update, metadata promotion, and cleanup", async () => {
		const calls: string[] = []
		const options = createOptions({
			download: async (archivePath) => {
				calls.push("download")
				await writeFile(archivePath, "archive")
			},
			verifyArchive: async () => {
				calls.push("verify")
			},
			extractArchive: async (_archivePath, stagingDir) => {
				calls.push("extract")
				await writeFile(path.join(stagingDir, "example"), "binary")
			},
			validateBinary: async () => {
				calls.push("validate")
			},
		})
		const paths = getManagedBinaryPaths(options)

		await expect(ensureManagedBinaryInstalled(options)).resolves.toBe(paths.binaryPath)
		expect(calls).toEqual(["download", "verify", "extract", "validate"])
		expect(await readFile(paths.binaryPath, "utf8")).toBe("binary")
		expect(await readFile(paths.versionPath, "utf8")).toBe(options.version)
		await expect(access(paths.archivePath)).rejects.toThrow()
		await expect(access(paths.stagingDir)).rejects.toThrow()
	})
})
