import type { Dirent } from "fs"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import { historyItemSchema } from "@roo-code/types"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { Package } from "../../shared/package"
import { getStorageBasePath } from "../../utils/storage"

const ROO_EXTENSION_DOMAIN = "RooVeterinaryInc.roo-cline"
const ROO_STORAGE_DIRECTORY = ROO_EXTENSION_DOMAIN.toLowerCase()
const ROO_CONFIGURATION_SECTION = "roo-cline"
const IMPORTABLE_TASK_FILE_NAMES = [
	GlobalFileNames.historyItem,
	GlobalFileNames.uiMessages,
	GlobalFileNames.apiConversationHistory,
	GlobalFileNames.taskMetadata,
]

// Reject task IDs that could cause path traversal or filesystem confusion.
// Valid Roo task IDs are Unix-millisecond timestamps (all digits), but we
// conservatively allow any name that doesn't contain path separators or dots,
// and doesn't start with a hidden/reserved prefix.
const UNSAFE_TASK_ID_RE = /[/\\.]|^_/

export interface RooHistoryImportPaths {
	rooExtensionDomain: string
	zooExtensionDomain: string
	rooStorageRoots: string[]
	zooStorageRoot: string
}

export interface RooHistoryImportResult extends RooHistoryImportPaths {
	foundTaskCount: number
	importedTaskCount: number
	importedFileCount: number
}

export interface RooHistoryImportProgress {
	copiedFileCount: number
	totalFileCount: number
	importedTaskCount: number
	totalTaskCount: number
	currentTaskId?: string
	currentFileName?: string
}

interface ImportableTaskPlan {
	taskId: string
	sourceTaskDirectory: string
	fileNames: string[]
}

const toComparablePath = (candidatePath: string) => {
	const resolvedPath = path.resolve(candidatePath)
	return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath
}

const dedupePaths = (paths: string[]) => {
	const seen = new Set<string>()
	return paths.filter((candidatePath) => {
		const comparablePath = toComparablePath(candidatePath)
		if (seen.has(comparablePath)) {
			return false
		}
		seen.add(comparablePath)
		return true
	})
}

const getConfiguredCustomStoragePath = (configurationSection: string) => {
	try {
		const configuredPath = vscode.workspace
			.getConfiguration(configurationSection)
			.get<string>("customStoragePath", "")
			.trim()
		return configuredPath || undefined
	} catch {
		return undefined
	}
}

// Only treat missing files as skippable — permission errors should propagate.
const isAbsent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"

// Validate that history_item.json parses as a HistoryItem and that its `id`
// field matches the task directory name. Prevents imported metadata from
// driving unsafe path operations downstream (TaskHistoryStore uses item.id
// directly in path.join calls).
const validateHistoryItem = async (filePath: string, expectedTaskId: string): Promise<boolean> => {
	try {
		const raw = await fs.readFile(filePath, "utf8")
		const parsed = historyItemSchema.safeParse(JSON.parse(raw))
		if (!parsed.success) {
			return false
		}
		return parsed.data.id === expectedTaskId && !UNSAFE_TASK_ID_RE.test(parsed.data.id)
	} catch {
		return false
	}
}

const isRegularFile = async (filePath: string): Promise<boolean> => {
	try {
		const stat = await fs.lstat(filePath)
		return stat.isFile()
	} catch {
		return false
	}
}

const copyTaskFileIfPresent = async (
	sourceTaskDirectory: string,
	stagingTaskDirectory: string,
	fileName: string,
): Promise<boolean> => {
	const sourcePath = path.join(sourceTaskDirectory, fileName)

	if (!(await isRegularFile(sourcePath))) {
		return false
	}

	await fs.mkdir(stagingTaskDirectory, { recursive: true })
	await fs.copyFile(sourcePath, path.join(stagingTaskDirectory, fileName))
	return true
}

const pathExists = async (candidatePath: string) => {
	try {
		await fs.access(candidatePath)
		return true
	} catch {
		return false
	}
}

export const isConcurrentDestinationClaimError = (error: unknown, destinationWasClaimed: boolean) => {
	const nodeError = error as NodeJS.ErrnoException
	return (
		destinationWasClaimed &&
		(nodeError.code === "EEXIST" || nodeError.code === "ENOTEMPTY" || nodeError.code === "EPERM")
	)
}

const getImportableTaskFileNames = async (sourceTaskDirectory: string) => {
	const fileNames: string[] = []

	for (const fileName of IMPORTABLE_TASK_FILE_NAMES) {
		try {
			const filePath = path.join(sourceTaskDirectory, fileName)
			if (await isRegularFile(filePath)) {
				fileNames.push(fileName)
			}
		} catch (error) {
			if (isAbsent(error)) {
				continue
			}
			throw error
		}
	}

	return fileNames
}

const collectImportableTaskPlans = async (sourceRoots: string[]) => {
	const taskPlans: ImportableTaskPlan[] = []
	const taskIds = new Set<string>()

	for (const sourceRoot of sourceRoots) {
		const sourceTasksRoot = path.join(sourceRoot, "tasks")
		let entries: Dirent[]

		try {
			entries = await fs.readdir(sourceTasksRoot, { withFileTypes: true })
		} catch (error) {
			const nodeError = error as NodeJS.ErrnoException
			if (nodeError.code === "ENOENT") {
				continue
			}
			throw error
		}

		for (const entry of entries) {
			if (!entry.isDirectory() || UNSAFE_TASK_ID_RE.test(entry.name)) {
				continue
			}

			// Preserve source-root priority: the first importable occurrence of a task ID wins.
			if (taskIds.has(entry.name)) {
				continue
			}

			const sourceTaskDirectory = path.join(sourceTasksRoot, entry.name)
			const fileNames = await getImportableTaskFileNames(sourceTaskDirectory)

			if (!fileNames.includes(GlobalFileNames.historyItem)) {
				continue
			}

			taskPlans.push({
				taskId: entry.name,
				sourceTaskDirectory,
				fileNames,
			})
			taskIds.add(entry.name)
		}
	}

	return {
		taskPlans,
		totalTaskCount: taskPlans.length,
	}
}

export const resolveRooHistoryImportPaths = async (globalStoragePath: string): Promise<RooHistoryImportPaths> => {
	const zooExtensionDomain = `${Package.publisher}.${Package.name}`
	const zooStorageRoot = await getStorageBasePath(globalStoragePath)
	const rooDefaultStorageRoot = path.join(path.dirname(globalStoragePath), ROO_STORAGE_DIRECTORY)
	const rooCustomStorageRoot = getConfiguredCustomStoragePath(ROO_CONFIGURATION_SECTION)

	return {
		rooExtensionDomain: ROO_EXTENSION_DOMAIN,
		zooExtensionDomain,
		rooStorageRoots: dedupePaths([rooDefaultStorageRoot, ...(rooCustomStorageRoot ? [rooCustomStorageRoot] : [])]),
		zooStorageRoot,
	}
}

export const importRooTaskHistory = async (
	globalStoragePath: string,
	onProgress?: (progress: RooHistoryImportProgress) => Promise<void> | void,
): Promise<RooHistoryImportResult> => {
	const paths = await resolveRooHistoryImportPaths(globalStoragePath)
	const destinationComparablePath = toComparablePath(paths.zooStorageRoot)
	const sourceRoots = paths.rooStorageRoots.filter(
		(sourceRoot) => toComparablePath(sourceRoot) !== destinationComparablePath,
	)
	const destinationTasksRoot = path.join(paths.zooStorageRoot, "tasks")
	const { taskPlans, totalTaskCount: foundTaskCount } = await collectImportableTaskPlans(sourceRoots)
	const importedTaskIds = new Set<string>()
	let importedFileCount = 0
	let copiedFileCount = 0
	let stagingFileCount = 0
	// Tracks tasks whose history_item has been staged but not yet atomically
	// promoted — used so progress reports show 1-based task count during copy.
	let inFlightTaskCount = 0
	const importableTaskPlans: ImportableTaskPlan[] = []

	await fs.mkdir(destinationTasksRoot, { recursive: true })

	for (const taskPlan of taskPlans) {
		const destinationTaskDirectory = path.join(destinationTasksRoot, taskPlan.taskId)
		if (await pathExists(destinationTaskDirectory)) {
			continue
		}

		importableTaskPlans.push(taskPlan)
	}

	const totalTaskCount = importableTaskPlans.length
	let totalFileCount = importableTaskPlans.reduce((count, taskPlan) => count + taskPlan.fileNames.length, 0)

	const reportProgress = async (currentTaskId?: string, currentFileName?: string) => {
		if (!onProgress) {
			return
		}

		await onProgress({
			copiedFileCount,
			totalFileCount,
			importedTaskCount: importedTaskIds.size + inFlightTaskCount,
			totalTaskCount,
			currentTaskId,
			currentFileName,
		})
	}

	await reportProgress()

	for (const taskPlan of importableTaskPlans) {
		const destinationTaskDirectory = path.join(destinationTasksRoot, taskPlan.taskId)

		// Re-check under the loop — a concurrent import may have claimed this task.
		if (await pathExists(destinationTaskDirectory)) {
			totalFileCount -= taskPlan.fileNames.length
			continue
		}

		// Stage into a unique temp directory, then atomically rename to avoid
		// leaving partial task directories that a retry would skip as already-present.
		// Using mkdtemp ensures concurrent imports for the same task ID don't collide.
		const stagingDirectory = await fs.mkdtemp(path.join(destinationTasksRoot, `_staging_${taskPlan.taskId}_`))
		stagingFileCount = 0

		try {
			const historyItemCopied = await copyTaskFileIfPresent(
				taskPlan.sourceTaskDirectory,
				stagingDirectory,
				GlobalFileNames.historyItem,
			)

			if (!historyItemCopied) {
				totalFileCount -= taskPlan.fileNames.length
				await reportProgress(taskPlan.taskId, GlobalFileNames.historyItem)
				continue
			}

			// Validate the staged history_item.json: it must parse as a valid
			// HistoryItem and its id must match the directory name exactly.
			const stagedHistoryItemPath = path.join(stagingDirectory, GlobalFileNames.historyItem)
			if (!(await validateHistoryItem(stagedHistoryItemPath, taskPlan.taskId))) {
				totalFileCount -= taskPlan.fileNames.length
				await reportProgress(taskPlan.taskId, GlobalFileNames.historyItem)
				continue
			}

			stagingFileCount += 1
			copiedFileCount += 1
			inFlightTaskCount = 1
			await reportProgress(taskPlan.taskId, GlobalFileNames.historyItem)

			for (const fileName of taskPlan.fileNames) {
				if (fileName === GlobalFileNames.historyItem) {
					continue
				}

				if (await copyTaskFileIfPresent(taskPlan.sourceTaskDirectory, stagingDirectory, fileName)) {
					stagingFileCount += 1
					copiedFileCount += 1
				} else {
					totalFileCount -= 1
				}

				await reportProgress(taskPlan.taskId, fileName)
			}

			// Atomic promotion: rename staging → destination.
			// If destination was concurrently created, treat it as a skip.
			try {
				await fs.rename(stagingDirectory, destinationTaskDirectory)
				importedTaskIds.add(taskPlan.taskId)
				importedFileCount += stagingFileCount
			} catch (renameError) {
				const destinationWasClaimed = await pathExists(destinationTaskDirectory)
				if (!isConcurrentDestinationClaimError(renameError, destinationWasClaimed)) {
					throw renameError
				}
				// Destination claimed concurrently — discard staging, uncount progress.
				copiedFileCount -= stagingFileCount
				totalFileCount -= taskPlan.fileNames.length
			} finally {
				inFlightTaskCount = 0
			}
		} finally {
			await fs.rm(stagingDirectory, { recursive: true, force: true })
		}
	}

	return {
		...paths,
		rooStorageRoots: sourceRoots,
		foundTaskCount,
		importedTaskCount: importedTaskIds.size,
		importedFileCount,
	}
}
