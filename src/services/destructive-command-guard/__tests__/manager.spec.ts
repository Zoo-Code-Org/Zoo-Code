import { createHash } from "crypto"
import { EventEmitter } from "events"
import { access, chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { PassThrough } from "stream"

import { spawn } from "child_process"
import { get } from "https"
import type { IncomingMessage, RequestOptions } from "http"

import { DCG_ARCHIVES, DCG_VERSION } from "../constants"
import {
	downloadFile,
	extractSingleBinary,
	getDcgArchiveInfo,
	getDcgBinaryPath,
	isDcgSupportedPlatform,
	isTrustedDownloadUrl,
	resolveTrustedRedirect,
	ensureDcgInstalled,
	verifyChecksum,
} from "../manager"

vi.mock("child_process", () => ({ spawn: vi.fn() }))
vi.mock("https", () => ({ get: vi.fn() }))

const mockSpawn = vi.mocked(spawn)
const mockGet = vi.mocked(get)

describe("Destructive Command Guard manager", () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "dcg-manager-"))
		mockSpawn.mockReset()
		mockGet.mockReset()
	})

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true })
	})

	it("maps all supported platform and architecture combinations", () => {
		expect(Object.keys(DCG_ARCHIVES).sort()).toEqual(["darwin-arm64", "linux-arm64", "linux-x64", "win32-x64"])
		expect(getDcgArchiveInfo("darwin", "arm64")?.archive).toBe("dcg-aarch64-apple-darwin.tar.xz")
		expect(getDcgArchiveInfo("win32", "x64")?.binary).toBe("dcg.exe")
	})

	it("rejects unsupported platforms", () => {
		expect(isDcgSupportedPlatform("freebsd", "x64")).toBe(false)
		expect(getDcgBinaryPath("/storage", "freebsd", "x64")).toBeUndefined()
	})

	it("returns the managed binary path", () => {
		expect(getDcgBinaryPath("/storage", "linux", "x64")).toBe(
			path.join("/storage", "destructive-command-guard", "dcg"),
		)
	})

	it("accepts only HTTPS URLs on trusted host boundaries", () => {
		expect(isTrustedDownloadUrl("https://github.com/release")).toBe(true)
		expect(isTrustedDownloadUrl("https://cdn.objects.githubusercontent.com/release")).toBe(true)
		expect(isTrustedDownloadUrl("http://github.com/release")).toBe(false)
		expect(isTrustedDownloadUrl("https://evilgithub.com/release")).toBe(false)
		expect(isTrustedDownloadUrl("not a URL")).toBe(false)
	})

	it("rejects untrusted download URLs before opening a destination", async () => {
		await expect(downloadFile("https://example.com/dcg", path.join(tempDir, "archive"))).rejects.toThrow(
			"DCG download redirected to an untrusted host",
		)
	})

	it("allows trusted relative redirects and rejects unsafe or exhausted redirects", () => {
		expect(resolveTrustedRedirect("https://github.com/release", "/asset", 5)).toBe("https://github.com/asset")
		expect(() => resolveTrustedRedirect("https://github.com/release", "https://example.com/asset", 5)).toThrow(
			"DCG download redirected to an untrusted host",
		)
		expect(() => resolveTrustedRedirect("https://github.com/release", "/asset", 0)).toThrow(
			"Too many DCG download redirects",
		)
		expect(() => resolveTrustedRedirect("https://github.com/release", undefined, 5)).toThrow(
			"Too many DCG download redirects",
		)
	})

	it("verifies matching checksums and rejects mismatches", async () => {
		const filePath = path.join(tempDir, "archive")
		const contents = Buffer.from("verified archive")
		await writeFile(filePath, contents)
		const checksum = createHash("sha256").update(contents).digest("hex")

		await expect(verifyChecksum(filePath, checksum)).resolves.toBeUndefined()
		await expect(verifyChecksum(filePath, "0".repeat(64))).rejects.toThrow(
			"DCG archive checksum verification failed",
		)
	})

	it("uses the platform ZIP extractor", async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn(),
		})
		// The production code uses only the event and stream subset supplied by this test double.
		mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>)

		const extraction = extractSingleBinary("C:\\dcg.zip", "C:\\staging", DCG_ARCHIVES["win32-x64"])
		child.emit("close", 0)
		await extraction

		const expectedExecutable = process.platform === "win32" ? "powershell" : "unzip"
		const expectedArgs =
			process.platform === "win32"
				? ["-NoProfile", "-Command", "Expand-Archive -Path 'C:\\dcg.zip' -DestinationPath 'C:\\staging' -Force"]
				: ["-o", "C:\\dcg.zip", "-d", "C:\\staging"]

		expect(mockSpawn).toHaveBeenCalledWith(expectedExecutable, expectedArgs, {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		})
	})

	it("extracts tar archives without imposing a single-file layout", async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn(),
		})
		// The production code uses only the event and stream subset supplied by this test double.
		mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>)

		const extraction = extractSingleBinary("/tmp/dcg.tar.xz", tempDir, DCG_ARCHIVES["linux-x64"])
		child.emit("close", 0)

		await expect(extraction).resolves.toBeUndefined()
		expect(mockSpawn).toHaveBeenCalledTimes(1)
		expect(mockSpawn).toHaveBeenCalledWith(
			"tar",
			expect.arrayContaining(["-xJf", "/tmp/dcg.tar.xz", "-C", tempDir, "--no-same-owner"]),
			expect.objectContaining({ shell: false }),
		)
	})

	it("surfaces process failures during extraction", async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn(),
		})
		mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>)

		const extraction = extractSingleBinary("/tmp/dcg.tar.xz", tempDir, DCG_ARCHIVES["linux-x64"])
		child.stderr.write("invalid archive")
		child.emit("close", 2)

		await expect(extraction).rejects.toThrow("invalid archive")
	})

	it("reuses an existing managed binary and restores its executable permissions", async () => {
		const binaryPath = getDcgBinaryPath(tempDir)
		expect(binaryPath).toBeDefined()
		await mkdir(path.dirname(binaryPath!), { recursive: true })
		await writeFile(binaryPath!, "existing binary")
		await writeFile(path.join(path.dirname(binaryPath!), ".dcg-version"), DCG_VERSION)
		if (process.platform !== "win32") {
			await chmod(binaryPath!, 0o600)
		}

		await expect(ensureDcgInstalled(tempDir)).resolves.toBe(binaryPath)
		expect(mockSpawn).not.toHaveBeenCalled()
		if (process.platform !== "win32") {
			expect((await stat(binaryPath!)).mode & 0o111).toBe(0o111)
		}
	})

	it("downloads, verifies, extracts, and deduplicates a new installation", async () => {
		const info = getDcgArchiveInfo()
		expect(info).toBeDefined()
		if (!info || info.archive.endsWith(".zip")) return

		const archive = Buffer.from("test archive")
		const originalChecksum = info.sha256
		Object.defineProperty(info, "sha256", {
			value: createHash("sha256").update(archive).digest("hex"),
			configurable: true,
		})
		const response = Object.assign(new PassThrough(), {
			statusCode: 200,
			headers: { "content-length": String(archive.length) },
		})
		const request = Object.assign(new EventEmitter(), {
			setTimeout: vi.fn(),
			destroy: vi.fn(),
		})
		mockGet.mockImplementation(
			(
				_url: string | URL,
				optionsOrCallback: RequestOptions | ((response: IncomingMessage) => void),
				optionalCallback?: (response: IncomingMessage) => void,
			) => {
				const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : optionalCallback
				setImmediate(() => {
					// The downloader uses only the response stream/status subset supplied here.
					callback?.(response as unknown as IncomingMessage)
					response.end(archive)
				})
				// The downloader uses only timeout/error handling from ClientRequest.
				return request as unknown as ReturnType<typeof get>
			},
		)

		mockSpawn.mockImplementation((executable, args) => {
			const child = Object.assign(new EventEmitter(), {
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				kill: vi.fn(),
			})
			setImmediate(async () => {
				if (executable === "tar") {
					const stagingDir = args[args.indexOf("-C") + 1]
					await writeFile(path.join(stagingDir, info.binary), "executable")
				}
				child.emit("close", 0)
			})
			// The process runner uses only the event and stream subset supplied here.
			return child as unknown as ReturnType<typeof spawn>
		})

		try {
			const firstInstallation = ensureDcgInstalled(tempDir)
			const concurrentInstallation = ensureDcgInstalled(tempDir)
			expect(concurrentInstallation).toBe(firstInstallation)

			const binaryPath = await firstInstallation
			if (!binaryPath) throw new Error("Expected DCG to be supported in this test")
			expect(await readFile(binaryPath, "utf8")).toBe("executable")
			expect(mockGet).toHaveBeenCalledTimes(1)
			expect(mockSpawn).toHaveBeenCalledTimes(1)
			await expect(access(path.join(tempDir, `${DCG_VERSION}-${info.archive}`))).rejects.toThrow()
			expect(await readFile(path.join(tempDir, "destructive-command-guard", ".dcg-version"), "utf8")).toBe(
				DCG_VERSION,
			)
		} finally {
			Object.defineProperty(info, "sha256", { value: originalChecksum, configurable: true })
		}
	})
})
