/**
 * Content Reference Tool — Terminal Source Resolver
 *
 * Resolves content references pointing to command output artifacts
 * stored in the task's command-output directory.
 */

import * as fs from "fs/promises"
import * as path from "path"
import type { ContentRef } from "../../../../shared/tools"
import type { SelectorResult } from "../selector"
import { resolveContentRef } from "../selector"
import type { Task } from "../../../task/Task"
import { getTaskDirectoryPath } from "../../../../utils/storage"
import { info, successCrt, error } from "../superDebug"

/**
 * Resolve a terminal source reference by reading a command output artifact.
 *
 * Resolution strategy:
 *   1. Direct artifact path: ref.ref = "cmd-xxx.txt"
 *   2. Content fingerprint matching: scan command-output files for startAnchor
 *
 * @param ref  - ContentRef with ref.ref as artifact filename or startAnchor for fingerprint matching
 * @param task - Current task instance for accessing the command-output directory
 * @returns SelectorResult with the extracted content fragment
 * @throws If task directory is unavailable, artifact not found, or matching fails
 */
export async function resolveTerminalSource(ref: ContentRef, task: Task): Promise<SelectorResult> {
	// Get task directory path via provider
	const provider = task.providerRef.deref()
	const globalStoragePath = provider?.context?.globalStorageUri?.fsPath
	if (!globalStoragePath) {
		error("TERMINAL_SOURCE", "Global storage path not available")
		throw new Error("Global storage path not available for terminal source resolution.")
	}

	info("TERMINAL_SOURCE", `resolveTerminalSource: ref="${ref.ref}", startAnchor="${ref.startAnchor ?? ""}"`)

	const taskDirPath = await getTaskDirectoryPath(globalStoragePath, task.taskId)

	// Try direct path first (ref.ref = "cmd-xxx.txt")
	let artifactPath = path.join(taskDirPath, "command-output", ref.ref)
	let content: string | null = null

	try {
		content = await fs.readFile(artifactPath, "utf-8")
	} catch {
		// If ref.ref is empty or not found, try content fingerprint matching
		if (!ref.ref && ref.startAnchor) {
			// Scan command-output directory for matching files
			const outputDir = path.join(taskDirPath, "command-output")
			let files: string[]
			try {
				files = await fs.readdir(outputDir)
			} catch {
				throw new Error("Command output directory not found.")
			}

			// Try to match by first few chars of content (startAnchor can be the command itself)
			for (const file of files) {
				if (!file.startsWith("cmd-")) continue
				const filePath = path.join(outputDir, file)
				const fileContent = await fs.readFile(filePath, "utf-8")
				if (fileContent.includes(ref.startAnchor)) {
					content = fileContent
					artifactPath = filePath
					break
				}
			}

			if (content === null) {
				throw new Error(`No terminal output found containing: ${ref.startAnchor}`)
			}
		} else {
			throw new Error(`Terminal artifact not found: ${ref.ref}`)
		}
	}

	const sourceId = `terminal://${path.basename(artifactPath)}`
	info("TERMINAL_SOURCE", `Artifact resolved: path="${path.basename(artifactPath)}", contentLength=${content.length}`)
	const result = await resolveContentRef(sourceId, content, ref)
	successCrt("TERMINAL_SOURCE", `resolved terminal artifact "${path.basename(artifactPath)}"`, {
		sourceId: result.sourceId,
		confidence: result.confidence,
		contentLength: result.content.length,
	})
	return result
}
