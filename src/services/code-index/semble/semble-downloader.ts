import * as fs from "fs/promises"
import * as path from "path"
import * as https from "https"
import { createWriteStream } from "fs"
import { spawn } from "child_process"

/**
 * Supported platform/arch combinations for the semble standalone executable.
 * Maps to archive names at https://github.com/navedmerchant/sembleexec/releases
 *
 * Uses "fast-start" archives (one-dir builds) for ~20x faster startup
 * compared to single-file binaries.
 */
const SEMBLE_ARCHIVES: Record<string, { archive: string; binary: string }> = {
	"linux-x64": { archive: "semble-linux-x64-fast.tar.gz", binary: "semble" },
	"linux-arm64": { archive: "semble-linux-arm64-fast.tar.gz", binary: "semble" },
	"darwin-arm64": { archive: "semble-macos-arm64-fast.tar.gz", binary: "semble" },
	"win32-x64": { archive: "semble-windows-x64-fast.zip", binary: "semble.exe" },
}

const SEMBLE_VERSION = "v0.3.1"
const DOWNLOAD_BASE_URL = `https://github.com/navedmerchant/sembleexec/releases/download/${SEMBLE_VERSION}`

/**
 * Returns whether the current platform/arch has a prebuilt semble binary available.
 */
export function isSembleSupportedPlatform(platform?: string, arch?: string): boolean {
	const p = platform ?? process.platform
	const a = arch ?? process.arch
	return `${p}-${a}` in SEMBLE_ARCHIVES
}

/**
 * Returns the list of supported platform-arch keys (e.g. "linux-x64", "darwin-arm64").
 */
export function getSembleSupportedPlatforms(): string[] {
	return Object.keys(SEMBLE_ARCHIVES)
}

/**
 * Returns the archive info for the given platform/arch, or undefined if unsupported.
 */
function getArchiveInfo(platform?: string, arch?: string): { archive: string; binary: string } | undefined {
	const p = platform ?? process.platform
	const a = arch ?? process.arch
	return SEMBLE_ARCHIVES[`${p}-${a}`]
}

/**
 * Downloads and extracts the semble archive for the current platform.
 *
 * The archive is extracted into `storageDir/semble/` and the binary path
 * is `storageDir/semble/<binary>`.
 *
 * @param storageDir - Directory to store the extracted binary (e.g. globalStorageUri.fsPath)
 * @returns The full path to the semble executable, or undefined if the platform is unsupported.
 */
export async function downloadSemble(storageDir: string): Promise<string | undefined> {
	const info = getArchiveInfo()
	if (!info) {
		return undefined
	}

	// Ensure storage directory exists
	await fs.mkdir(storageDir, { recursive: true })

	const extractDir = path.join(storageDir, "semble")
	const binaryPath = path.join(extractDir, info.binary)

	// Check if already downloaded and extracted
	try {
		await fs.access(binaryPath)
		// Binary exists, make sure it's executable
		if (process.platform !== "win32") {
			await fs.chmod(binaryPath, 0o755)
		}
		return binaryPath
	} catch {
		// Not present, download and extract it
	}

	const url = `${DOWNLOAD_BASE_URL}/${info.archive}`
	const archivePath = path.join(storageDir, info.archive)
	console.log(`[SembleDownloader] Downloading semble from ${url}`)

	try {
		await downloadFile(url, archivePath)

		// Extract the archive
		await fs.mkdir(extractDir, { recursive: true })

		if (info.archive.endsWith(".tar.gz")) {
			await extractTarGz(archivePath, extractDir)
		} else if (info.archive.endsWith(".zip")) {
			await extractZip(archivePath, extractDir)
		}

		// Make binary executable on unix platforms
		if (process.platform !== "win32") {
			await fs.chmod(binaryPath, 0o755)
		}

		// Clean up the archive file
		try {
			await fs.unlink(archivePath)
		} catch {
			// ignore cleanup errors
		}

		console.log(`[SembleDownloader] Successfully extracted semble to ${binaryPath}`)
		return binaryPath
	} catch (error: any) {
		// Clean up partial download/extraction
		try {
			await fs.unlink(archivePath)
		} catch {
			// ignore cleanup errors
		}
		try {
			await fs.rm(extractDir, { recursive: true, force: true })
		} catch {
			// ignore cleanup errors
		}
		console.error(`[SembleDownloader] Failed to download semble: ${error?.message || error}`)
		throw new Error(`Failed to download semble: ${error?.message || error}`)
	}
}

/**
 * Returns the path to the semble binary if it's already been downloaded, or undefined.
 */
export async function getSembleBinaryPath(storageDir: string): Promise<string | undefined> {
	const info = getArchiveInfo()
	if (!info) {
		return undefined
	}

	const binaryPath = path.join(storageDir, "semble", info.binary)

	try {
		await fs.access(binaryPath)
		return binaryPath
	} catch {
		return undefined
	}
}

/**
 * Extracts a .tar.gz archive into the destination directory using the system `tar` command.
 */
function extractTarGz(archivePath: string, destDir: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("tar", ["-xzf", archivePath, "-C", destDir], {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		})

		let stderr = ""
		child.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString()
		})

		child.on("error", (err) => reject(err))
		child.on("close", (code) => {
			if (code === 0) {
				resolve()
			} else {
				reject(new Error(`tar extraction failed (code ${code}): ${stderr.trim()}`))
			}
		})
	})
}

/**
 * Extracts a .zip archive into the destination directory.
 * Uses PowerShell on Windows, unzip on other platforms.
 */
function extractZip(archivePath: string, destDir: string): Promise<void> {
	return new Promise((resolve, reject) => {
		let child

		if (process.platform === "win32") {
			child = spawn(
				"powershell",
				[
					"-NoProfile",
					"-Command",
					`Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`,
				],
				{ shell: false, stdio: ["ignore", "pipe", "pipe"] },
			)
		} else {
			child = spawn("unzip", ["-o", archivePath, "-d", destDir], {
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			})
		}

		let stderr = ""
		child.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString()
		})

		child.on("error", (err) => reject(err))
		child.on("close", (code) => {
			if (code === 0) {
				resolve()
			} else {
				reject(new Error(`zip extraction failed (code ${code}): ${stderr.trim()}`))
			}
		})
	})
}

/**
 * Downloads a file from the given URL to the destination path.
 * Follows redirects (GitHub releases use 302 redirects to CDN).
 */
function downloadFile(url: string, destPath: string, maxRedirects = 5): Promise<void> {
	return new Promise((resolve, reject) => {
		if (maxRedirects <= 0) {
			reject(new Error("Too many redirects"))
			return
		}

		const request = https.get(url, (response) => {
			// Follow redirects
			if (
				response.statusCode &&
				response.statusCode >= 300 &&
				response.statusCode < 400 &&
				response.headers.location
			) {
				response.destroy()
				downloadFile(response.headers.location, destPath, maxRedirects - 1)
					.then(resolve)
					.catch(reject)
				return
			}

			if (response.statusCode !== 200) {
				response.destroy()
				reject(new Error(`HTTP ${response.statusCode}: Failed to download ${url}`))
				return
			}

			const file = createWriteStream(destPath)
			response.pipe(file)

			file.on("finish", () => {
				file.close()
				resolve()
			})

			file.on("error", (err) => {
				file.close()
				reject(err)
			})
		})

		request.on("error", reject)
		request.on("timeout", () => {
			request.destroy()
			reject(new Error("Download timed out"))
		})

		// 2 minute timeout for download
		request.setTimeout(120_000)
	})
}
