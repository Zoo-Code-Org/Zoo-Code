import * as fs from "fs/promises"
import * as path from "path"
import * as https from "https"
import { createWriteStream } from "fs"
import { createHash } from "crypto"
import { createReadStream } from "fs"
import { spawn } from "child_process"

/**
 * Supported platform/arch combinations for the semble standalone executable.
 * Maps to archive names at https://github.com/Zoo-Code-Org/sembleexec/releases
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
const DOWNLOAD_BASE_URL = `https://github.com/Zoo-Code-Org/sembleexec/releases/download/${SEMBLE_VERSION}`
const VERSION_FILE = ".semble-version"

/**
 * SHA-256 checksums for each platform archive at SEMBLE_VERSION.
 * These are verified after download to guard against tampered release assets.
 * Update these when bumping SEMBLE_VERSION.
 *
 * To regenerate: `shasum -a 256 <archive-file>`
 */
const SEMBLE_SHA256: Record<string, string> = {
	"linux-x64": "2bd4117dbd1ff7a26ed5ef44dad8d43162a4b9f431ec0bcc9dd2f9c6f5952e28",
	"linux-arm64": "177d14f41d3272594844a2635d59d97ad20400868a874a59169fd26a868c32a5",
	"darwin-arm64": "9130f447ff2c21803853a9aee58268f0e05134326384ac23d8b74ed22905e118",
	"win32-x64": "c8ae86f3703675e356824e08cf79c8a20c41c602296d2a5bff15bf35d762a46b",
}

/**
 * Verifies the SHA-256 checksum of a downloaded file against the expected value.
 * Throws if the checksum does not match.
 */
export async function verifyChecksum(filePath: string, expected: string): Promise<void> {
	const hash = createHash("sha256")
	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(filePath)
		stream.on("data", (chunk) => hash.update(chunk))
		stream.on("end", resolve)
		stream.on("error", reject)
	})
	const actual = hash.digest("hex")
	if (actual !== expected) {
		throw new Error(
			`Checksum mismatch for ${path.basename(filePath)}: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…`,
		)
	}
}

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
 * Reads the locally installed version from the version metadata file.
 * Returns undefined if no version file exists (first install or legacy).
 */
async function getInstalledVersion(storageDir: string): Promise<string | undefined> {
	try {
		const versionPath = path.join(storageDir, "semble", VERSION_FILE)
		const version = (await fs.readFile(versionPath, "utf-8")).trim()
		return version || undefined
	} catch {
		return undefined
	}
}

/**
 * Writes the version metadata file after a successful download.
 */
async function writeInstalledVersion(storageDir: string, version: string): Promise<void> {
	const versionPath = path.join(storageDir, "semble", VERSION_FILE)
	await fs.writeFile(versionPath, version, "utf-8")
}

/**
 * Downloads and extracts the semble archive for the current platform.
 *
 * Compares the hardcoded SEMBLE_VERSION against the version stored on disk.
 * If they differ (i.e. the version was bumped in source), it re-downloads.
 * Otherwise it returns the existing binary path.
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

	// Check if already downloaded at the correct version
	const installedVersion = await getInstalledVersion(storageDir)

	if (installedVersion === SEMBLE_VERSION) {
		try {
			await fs.access(binaryPath)
			// Binary exists and version matches — nothing to do
			if (process.platform !== "win32") {
				await fs.chmod(binaryPath, 0o755)
			}
			return binaryPath
		} catch {
			// Binary missing despite version file — re-download below
		}
	}

	// Version mismatch — use staging directory to avoid leaving user without binary
	if (installedVersion && installedVersion !== SEMBLE_VERSION) {
		console.log(`[SembleDownloader] Version changed from ${installedVersion} to ${SEMBLE_VERSION}, updating...`)
	}

	const url = `${DOWNLOAD_BASE_URL}/${info.archive}`
	const archivePath = path.join(storageDir, info.archive)
	// Stage the new installation in a temporary directory. The old binary stays
	// intact until the new one is fully verified, preventing broken state on failure.
	const stagingDir = extractDir + ".new"
	const stagedBinaryPath = path.join(stagingDir, info.binary)
	console.log(`[SembleDownloader] Downloading semble ${SEMBLE_VERSION} from ${url}`)

	try {
		// Clean any leftover staging directory from a previous failed attempt
		try {
			await fs.rm(stagingDir, { recursive: true, force: true })
		} catch {
			// ignore
		}

		await downloadFile(url, archivePath)

		// Verify archive integrity before extraction
		const platformKey = `${process.platform}-${process.arch}`
		const expectedChecksum = SEMBLE_SHA256[platformKey]
		if (!expectedChecksum) {
			throw new Error(`No checksum configured for platform ${platformKey} at ${SEMBLE_VERSION}`)
		}
		await verifyChecksum(archivePath, expectedChecksum)

		// Extract to staging directory
		await fs.mkdir(stagingDir, { recursive: true })

		if (info.archive.endsWith(".tar.gz")) {
			await extractTarGz(archivePath, stagingDir)
		} else if (info.archive.endsWith(".zip")) {
			await extractZip(archivePath, stagingDir)
		}

		// Make binary executable on unix platforms
		if (process.platform !== "win32") {
			await fs.chmod(stagedBinaryPath, 0o755)
		}

		// Verify the staged binary exists before swapping
		await fs.access(stagedBinaryPath)

		// Atomic swap: remove old installation, rename staging → final
		try {
			await fs.rm(extractDir, { recursive: true, force: true })
		} catch {
			// ignore — may not exist on first install
		}
		await fs.rename(stagingDir, extractDir)

		// Record the installed version
		await writeInstalledVersion(storageDir, SEMBLE_VERSION)

		// Clean up the archive file
		try {
			await fs.unlink(archivePath)
		} catch {
			// ignore cleanup errors
		}

		console.log(`[SembleDownloader] Successfully installed semble ${SEMBLE_VERSION} to ${binaryPath}`)
		return binaryPath
	} catch (error: any) {
		// Clean up partial download/staging — leave old installation intact
		try {
			await fs.unlink(archivePath)
		} catch {
			// ignore cleanup errors
		}
		try {
			await fs.rm(stagingDir, { recursive: true, force: true })
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
 * Uses --no-same-owner to avoid issues with permission elevation,
 * strips absolute paths and blocks directory overwrites to prevent path traversal attacks.
 */
function extractTarGz(archivePath: string, destDir: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const args = ["-xzf", archivePath, "-C", destDir, "--no-same-owner"]
		// GNU tar: --no-overwrite-dir adds defense-in-depth against ../relative traversal.
		// macOS bsdtar strips absolute paths by default.
		if (process.platform === "linux") {
			args.push("--no-overwrite-dir")
		}
		const child = spawn("tar", args, {
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
 * Escapes a string for use inside a PowerShell single-quoted literal.
 * In PowerShell, the only special character in a single-quoted string is the
 * apostrophe itself, which is escaped by doubling it.
 */
function escapePowerShellLiteral(value: string): string {
	return value.replace(/'/g, "''")
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
					`Expand-Archive -Path '${escapePowerShellLiteral(archivePath)}' -DestinationPath '${escapePowerShellLiteral(destDir)}' -Force`,
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
 * Trusted domains for following redirects during semble binary download.
 * GitHub releases redirect to objects.githubusercontent.com for the actual download.
 */
const TRUSTED_DOWNLOAD_DOMAINS = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]

/**
 * Validates that a URL belongs to a trusted domain.
 * Uses domain-boundary aware matching to prevent suffix-based bypasses
 * (e.g. "evilgithub.com" does NOT match "github.com").
 */
function isTrustedDownloadUrl(url: string): boolean {
	try {
		const parsed = new URL(url)
		const h = parsed.hostname
		return parsed.protocol === "https:" && TRUSTED_DOWNLOAD_DOMAINS.some((d) => h === d || h.endsWith("." + d))
	} catch {
		return false
	}
}

/**
 * Downloads a file from the given URL to the destination path.
 * Follows redirects (GitHub releases use 302 redirects to CDN).
 * Only follows redirects to trusted domains to prevent redirect-based attacks.
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
				const redirectUrl = response.headers.location
				if (!isTrustedDownloadUrl(redirectUrl)) {
					reject(
						new Error(
							`Redirect to untrusted domain blocked: ${redirectUrl}. Only ${TRUSTED_DOWNLOAD_DOMAINS.join(", ")} are allowed.`,
						),
					)
					return
				}
				downloadFile(redirectUrl, destPath, maxRedirects - 1)
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
