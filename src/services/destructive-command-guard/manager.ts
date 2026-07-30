import * as path from "path"

import { extractTarXzArchive, extractZipArchive } from "../managed-binary/archive"
import {
	downloadBinaryFile,
	isTrustedHttpsUrl,
	resolveTrustedRedirect as resolveManagedBinaryRedirect,
	verifySha256Checksum,
} from "../managed-binary/download"
import { ensureManagedBinaryInstalled, getManagedBinaryPaths } from "../managed-binary/install"

import {
	DCG_ARCHIVES,
	DCG_DOWNLOAD_BASE_URL,
	DCG_TRUSTED_DOWNLOAD_DOMAINS,
	DCG_VERSION,
	type DcgArchiveInfo,
} from "./constants"

const VERSION_FILE = ".dcg-version"

export function getDcgArchiveInfo(platform = process.platform, arch = process.arch): DcgArchiveInfo | undefined {
	return DCG_ARCHIVES[`${platform}-${arch}`]
}

export function isDcgSupportedPlatform(platform = process.platform, arch = process.arch): boolean {
	return getDcgArchiveInfo(platform, arch) !== undefined
}

export function getDcgBinaryPath(
	storageDir: string,
	platform = process.platform,
	arch = process.arch,
): string | undefined {
	const info = getDcgArchiveInfo(platform, arch)
	return info ? path.join(storageDir, "destructive-command-guard", info.binary) : undefined
}

export function isTrustedDownloadUrl(url: string): boolean {
	return isTrustedHttpsUrl(url, DCG_TRUSTED_DOWNLOAD_DOMAINS)
}

export function resolveTrustedRedirect(url: string, location: string | undefined, redirectsRemaining: number): string {
	return resolveManagedBinaryRedirect(url, location, redirectsRemaining, {
		name: "DCG",
		trustedDomains: DCG_TRUSTED_DOWNLOAD_DOMAINS,
	})
}

export function downloadFile(url: string, destination: string, maxRedirects = 5): Promise<void> {
	return downloadBinaryFile(url, destination, {
		name: "DCG",
		trustedDomains: DCG_TRUSTED_DOWNLOAD_DOMAINS,
		timeoutMs: 120_000,
		maxRedirects,
	})
}

export async function verifyChecksum(filePath: string, expected: string): Promise<void> {
	await verifySha256Checksum(filePath, expected, () => new Error("DCG archive checksum verification failed"))
}

export async function extractSingleBinary(
	archivePath: string,
	stagingDir: string,
	info: DcgArchiveInfo,
): Promise<void> {
	if (info.archive.endsWith(".zip")) {
		await extractZipArchive(archivePath, stagingDir)
		return
	}

	await extractTarXzArchive(archivePath, stagingDir)
}

function installDcg(storageDir: string): Promise<string | undefined> {
	const info = getDcgArchiveInfo()
	if (!info) {
		return Promise.resolve(undefined)
	}

	return ensureManagedBinaryInstalled({
		storageDir,
		id: "destructive-command-guard",
		version: DCG_VERSION,
		versionFile: VERSION_FILE,
		archiveName: info.archive,
		binaryName: info.binary,
		errorPrefix: "Failed to download DCG",
		download: (archivePath) => downloadFile(`${DCG_DOWNLOAD_BASE_URL}/${info.archive}`, archivePath),
		verifyArchive: (archivePath) => verifyChecksum(archivePath, info.sha256),
		extractArchive: (archivePath, stagingDir) => extractSingleBinary(archivePath, stagingDir, info),
	})
}

export function ensureDcgInstalled(storageDir: string): Promise<string | undefined> {
	return installDcg(storageDir)
}
