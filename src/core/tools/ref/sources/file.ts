/**
 * Content Reference Tool — File Source Resolver
 *
 * Resolves content references pointing to files on disk.
 * Supports line range extraction and anchor/selector matching.
 */

import * as fs from "fs/promises"
import * as path from "path"
import type { ContentRef } from "../../../../shared/tools"
import type { SelectorResult } from "../selector"
import { resolveContentRef } from "../selector"
import type { Task } from "../../../task/Task"
import { info, successCrt, error } from "../superDebug"

/**
 * Resolve a file source reference by reading the file and matching content.
 *
 * Resolution priority:
 *   1. Line range (startLine/endLine) — extracted directly
 *   2. Anchor pair / selector — delegated to resolveContentRef
 *
 * @param ref  - ContentRef with ref.ref as a relative file path and optional line numbers
 * @param task - Current task instance providing cwd for relative path resolution
 * @returns SelectorResult with the extracted content fragment
 * @throws If file is not found, unreadable, or matching fails
 */
export async function resolveFileSource(ref: ContentRef, task: Task): Promise<SelectorResult> {
	// Resolve file path relative to task cwd
	const cwd = task.cwd || process.cwd()
	const filePath = path.resolve(cwd, ref.ref)

	info(
		"FILE_SOURCE",
		`resolveFileSource: filePath="${filePath}", startLine=${ref.startLine}, selector=${ref.selector ?? ""}`,
	)

	let content: string
	try {
		content = await fs.readFile(filePath, "utf-8")
		info("FILE_SOURCE", `File read: filePath="${filePath}", fileSize=${content.length}`)
	} catch (err) {
		error("FILE_SOURCE", `File not found: ${filePath}`, { ref })
		throw new Error(
			`File not found or unreadable: ${ref.ref} (resolved: ${filePath}). ${err instanceof Error ? err.message : ""}`,
		)
	}

	// Priority 1: Line range (startLine/endLine)
	if (ref.startLine !== undefined) {
		const lines = content.split("\n")
		const start = Math.max(0, ref.startLine - 1) // 1-based → 0-based
		const end = ref.endLine !== undefined ? Math.min(lines.length, ref.endLine) : start + 1

		const extracted = lines.slice(start, end).join("\n")
		const sourceId = `file://${filePath}:${ref.startLine}-${ref.endLine ?? ref.startLine}`
		info(
			"FILE_SOURCE",
			`Line range extraction: startLine=${ref.startLine}, endLine=${ref.endLine}, extractedLength=${extracted.length}`,
		)

		return {
			sourceId,
			content: extracted,
			startOffset: start,
			endOffset: end,
			confidence: 1.0,
			method: "exact",
		}
	}

	// Priority 2+: Anchor pair / selector / focus AST expansion
	const sourceId = `file://${filePath}`
	const result = await resolveContentRef(sourceId, content, ref, undefined, cwd)
	successCrt("FILE_SOURCE", `resolved file "${ref.ref}" via ${result.method}`, {
		sourceId: result.sourceId,
		confidence: result.confidence,
		contentLength: result.content.length,
	})
	return result
}
