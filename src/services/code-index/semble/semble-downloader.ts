import * as fs from "fs/promises"
import * as path from "path"

import { extractTarGzArchive, extractZipArchive } from "../../managed-binary/archive"
import { downloadBinaryFile, verifySha256Checksum } from "../../managed-binary/download"
import { ensureManagedBinaryInstalled, getManagedBinaryPaths } from "../../managed-binary/install"

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

/**
 * The bundled semble version. Surfaced to the UI via the provider's
 * system-state message so users can see which version is active.
 */
export const SEMBLE_VERSION = "v0.4.1"
const DOWNLOAD_BASE_URL = `https://github.com/Zoo-Code-Org/sembleexec/releases/download/${SEMBLE_VERSION}`
const VERSION_FILE = ".semble-version"

/**
 * SHA-256 checksums for each platform archive at SEMBLE_VERSION.
 * These are verified after download to guard against tampered release assets.
 * Update these when bumping SEMBLE_VERSION.
 *
 * To regenerate: `shasum -a 256 <archive-file>`
 */
export const SEMBLE_SHA256: Record<string, string> = {
	"linux-x64": "33a6c8ae78d750e917b291524d788747c62de795274def5c6b07b7a6d1671493",
	"linux-arm64": "a4a3fbca363f5a894a57594679c787ff6b4ac1332ebf0edcb36cc89f348c7aba",
	"darwin-arm64": "f8b5718e2264c9addbf61ac52f0106f1ebb6717980bf25ecfe135d12f164ed30",
	"win32-x64": "2a8734d486db1feaa3bd3cf111d1ac17c805102d758be8f5295fbc862ee00bb3",
}

/**
 * Verifies the SHA-256 checksum of a downloaded file against the expected value.
 * Throws if the checksum does not match.
 */
export async function verifyChecksum(filePath: string, expected: string): Promise<void> {
	await verifySha256Checksum(
		filePath,
		expected,
		(actual) =>
			new Error(
				`Checksum mismatch for ${path.basename(filePath)}: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…`,
			),
	)
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

	const url = `${DOWNLOAD_BASE_URL}/${info.archive}`
	const paths = getManagedBinaryPaths({
		storageDir,
		id: "semble",
		version: SEMBLE_VERSION,
		versionFile: VERSION_FILE,
		archiveName: info.archive,
		binaryName: info.binary,
	})
	console.log(`[SembleDownloader] Downloading semble ${SEMBLE_VERSION} from ${url}`)

	const platformKey = `${process.platform}-${process.arch}`
	const expectedChecksum = SEMBLE_SHA256[platformKey]
	if (!expectedChecksum) {
		throw new Error(`No checksum configured for platform ${platformKey} at ${SEMBLE_VERSION}`)
	}
	const result = await ensureManagedBinaryInstalled({
		storageDir,
		id: "semble",
		version: SEMBLE_VERSION,
		versionFile: VERSION_FILE,
		archiveName: info.archive,
		binaryName: info.binary,
		errorPrefix: "Failed to download semble",
		download: (archivePath) =>
			downloadBinaryFile(url, archivePath, {
				name: "Semble",
				trustedDomains: TRUSTED_DOWNLOAD_DOMAINS,
				timeoutMs: 120_000,
			}),
		verifyArchive: (archivePath) => verifyChecksum(archivePath, expectedChecksum),
		extractArchive: async (archivePath, stagingDir) => {
			if (info.archive.endsWith(".tar.gz")) {
				await extractTarGzArchive(archivePath, stagingDir)
			} else if (info.archive.endsWith(".zip")) {
				await extractZipArchive(archivePath, stagingDir)
			}
		},
	})

	console.log(`[SembleDownloader] Successfully installed semble ${SEMBLE_VERSION} to ${paths.binaryPath}`)
	return result
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
 * Trusted domains for following redirects during semble binary download.
 * GitHub releases redirect to objects.githubusercontent.com for the actual download.
 */
const TRUSTED_DOWNLOAD_DOMAINS = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]
