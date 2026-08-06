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
			errorPrefix: "Failed to install example",
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

	it("deduplicates concurrent installations", async () => {
		let finishDownload: (() => void) | undefined
		const download = vi.fn(() => new Promise<void>((resolve) => (finishDownload = resolve)))
		const options = createOptions({
			download,
			extractArchive: async (_archivePath, stagingDir) => {
				await writeFile(path.join(stagingDir, "example"), "binary")
			},
		})
		const first = ensureManagedBinaryInstalled(options)
		const second = ensureManagedBinaryInstalled(options)
		expect(first).toBe(second)
		await vi.waitFor(() => expect(download).toHaveBeenCalledOnce())
		finishDownload?.()
		await expect(Promise.all([first, second])).resolves.toEqual([
			getManagedBinaryPaths(options).binaryPath,
			getManagedBinaryPaths(options).binaryPath,
		])
		expect(download).toHaveBeenCalledOnce()
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
		await expect(access(path.join(tempDir, ".example.install.lock"))).rejects.toThrow()
	})

	it("cleans up partial artifacts when downloading fails", async () => {
		const options = createOptions({
			download: async (archivePath) => {
				await writeFile(archivePath, "partial")
				throw new Error("network failure")
			},
		})
		const paths = getManagedBinaryPaths(options)

		await expect(ensureManagedBinaryInstalled(options)).rejects.toThrow(
			"Failed to install example: network failure",
		)
		await expect(access(paths.archivePath)).rejects.toThrow()
		await expect(access(paths.stagingDir)).rejects.toThrow()
		await expect(access(paths.binaryPath)).rejects.toThrow()
	})

	it("removes stale versioned archives without touching unrelated files", async () => {
		const options = createOptions({
			download: async (archivePath) => writeFile(archivePath, "archive"),
			extractArchive: async (_archivePath, stagingDir) => {
				await writeFile(path.join(stagingDir, "example"), "binary")
			},
		})
		const staleArchive = path.join(tempDir, "v1.2.2-example.tar.gz")
		const unrelated = path.join(tempDir, "notes.txt")
		await writeFile(staleArchive, "stale")
		await writeFile(unrelated, "keep")

		await ensureManagedBinaryInstalled(options)

		await expect(access(staleArchive)).rejects.toThrow()
		await expect(readFile(unrelated, "utf8")).resolves.toBe("keep")
	})
})
