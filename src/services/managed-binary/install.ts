import * as fs from "fs/promises"
import * as path from "path"

const installationPromises = new Map<string, Promise<string>>()

export interface ManagedBinaryInstallOptions {
	storageDir: string
	id: string
	version: string
	versionFile: string
	archiveName: string
	binaryName: string
	download: (archivePath: string) => Promise<void>
	verifyArchive: (archivePath: string) => Promise<void>
	extractArchive: (archivePath: string, stagingDir: string) => Promise<void>
	validateBinary?: (stagedBinaryPath: string) => Promise<void>
	errorPrefix?: string
}

export interface ManagedBinaryPaths {
	installRoot: string
	binaryPath: string
	versionPath: string
	stagingDir: string
	stagedBinaryPath: string
	archivePath: string
}

export function getManagedBinaryPaths(
	options: Pick<
		ManagedBinaryInstallOptions,
		"storageDir" | "id" | "version" | "versionFile" | "archiveName" | "binaryName"
	>,
): ManagedBinaryPaths {
	const installRoot = path.join(options.storageDir, options.id)
	const stagingDir = path.join(options.storageDir, `${options.id}.new`)
	return {
		installRoot,
		binaryPath: path.join(installRoot, options.binaryName),
		versionPath: path.join(installRoot, options.versionFile),
		stagingDir,
		stagedBinaryPath: path.join(stagingDir, options.binaryName),
		archivePath: path.join(options.storageDir, `${options.version}-${options.archiveName}`),
	}
}

async function readInstalledVersion(versionPath: string): Promise<string | undefined> {
	try {
		const version = (await fs.readFile(versionPath, "utf8")).trim()
		return version || undefined
	} catch {
		return undefined
	}
}

async function makeExecutable(binaryPath: string): Promise<void> {
	await fs.access(binaryPath)
	if (process.platform !== "win32") {
		await fs.chmod(binaryPath, 0o755)
	}
}

async function cleanupStaleArchives(options: ManagedBinaryInstallOptions, currentArchivePath: string): Promise<void> {
	try {
		const entries = await fs.readdir(options.storageDir)
		const suffix = `-${options.archiveName}`
		await Promise.all(
			entries
				.filter(
					(name) =>
						(name === options.archiveName || name.endsWith(suffix)) &&
						path.join(options.storageDir, name) !== currentArchivePath,
				)
				.map((name) => fs.rm(path.join(options.storageDir, name), { force: true }).catch(() => {})),
		)
	} catch {
		// Archive cleanup is cosmetic and must not invalidate a successful installation.
	}
}

async function installManagedBinary(options: ManagedBinaryInstallOptions): Promise<string> {
	const paths = getManagedBinaryPaths(options)
	await fs.mkdir(options.storageDir, { recursive: true })
	const installedVersion = await readInstalledVersion(paths.versionPath)
	if (installedVersion === options.version) {
		try {
			await makeExecutable(paths.binaryPath)
			return paths.binaryPath
		} catch {
			// The installation is absent or incomplete, so rebuild it below.
		}
	}

	await fs.rm(paths.archivePath, { force: true }).catch(() => {})
	await fs.rm(paths.stagingDir, { recursive: true, force: true }).catch(() => {})
	await fs.mkdir(paths.stagingDir, { recursive: true })

	try {
		await options.download(paths.archivePath)
		await options.verifyArchive(paths.archivePath)
		await options.extractArchive(paths.archivePath, paths.stagingDir)
		await makeExecutable(paths.stagedBinaryPath)
		await options.validateBinary?.(paths.stagedBinaryPath)
		await fs.writeFile(path.join(paths.stagingDir, options.versionFile), options.version, "utf-8")
		await fs.rm(paths.installRoot, { recursive: true, force: true })
		await fs.rename(paths.stagingDir, paths.installRoot)
		await cleanupStaleArchives(options, paths.archivePath)
		return paths.binaryPath
	} catch (error) {
		if (!options.errorPrefix) {
			throw error
		}
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(`${options.errorPrefix}: ${message}`)
	} finally {
		await fs.rm(paths.archivePath, { force: true }).catch(() => {})
		await fs.rm(paths.stagingDir, { recursive: true, force: true }).catch(() => {})
	}
}

export function ensureManagedBinaryInstalled(options: ManagedBinaryInstallOptions): Promise<string> {
	const key = path.join(options.storageDir, options.id)
	const existing = installationPromises.get(key)
	if (existing) {
		return existing
	}

	const installation = installManagedBinary(options).finally(() => installationPromises.delete(key))
	installationPromises.set(key, installation)
	return installation
}
