/**
 * Content Reference Tool — ResolveRef Orchestrator
 *
 * Main entry point for content reference resolution. Processes a ContentRefParams
 * by dispatching to the appropriate source resolver (chat, file, terminal, tool),
 * then applies the transform pipeline to the resolved content.
 */

import * as fs from "fs"
import * as path from "path"
import type { ContentRefParams, ContentRef } from "../../../shared/tools"
import type { SelectorResult } from "./selector"
import { resolveContentRef } from "./selector"
import { applyTransform, applyMultiTransform } from "./transform"
import { resolveChatSource } from "./sources/chat"
import { resolveFileSource } from "./sources/file"
import { resolveTerminalSource } from "./sources/terminal"
import { resolveToolSource } from "./sources/tool"
import type { Task } from "../../task/Task"
import { info, warn, error as logError, callCrt, logCrt, successCrt, executeCrt } from "./superDebug"

// ─── Public Types ───────────────────────────────────────────────────────────

export interface ResolveRefResult {
	/** Primary content output (first fragment or joined) */
	content: string
	/** Joined content if join_with transform was specified */
	joined?: string
	/** All resolved selector results */
	resolved: SelectorResult[]
	/** Minimum confidence across all resolved fragments (1.0 = highest) */
	confidence: number
}

// ─── Main Orchestrator ──────────────────────────────────────────────────────

/**
 * Resolve content references from a ContentRefParams and apply transforms.
 *
 * Supports both single ref and multi_ref. Each ref is resolved independently
 * by its source type, then all fragments are run through the transform pipeline.
 *
 * @param refMeta - Content reference parameters (ref or multi_ref + transform)
 * @param task    - Current task instance for source resolution context
 * @returns ResolveRefResult with resolved content and metadata
 * @throws If no ref or multi_ref is specified, or if any resolution fails
 */
export async function resolveRef(refMeta: ContentRefParams, task: Task): Promise<ResolveRefResult> {
	const refs: ContentRef[] = []

	// Support simultaneous ref + multi_ref
	if (refMeta.ref) {
		refs.push(refMeta.ref)
	}
	if (refMeta.multi_ref && refMeta.multi_ref.length > 0) {
		refs.push(...refMeta.multi_ref)
	}

	if (refs.length === 0) {
		const errMsg = "No ref or multi_ref specified in refMeta."
		logError("RESOLVE_REF", errMsg, { refMeta })
		throw new Error(errMsg)
	}

	info("RESOLVE_REF", `resolveRef: ${refs.length} ref(s) to resolve`, {
		hasRef: !!refMeta.ref,
		hasMultiRef: !!refMeta.multi_ref,
		hasTransform: !!refMeta.transform,
	})

	// Resolve all refs with graceful fallback per ref
	const resolved: SelectorResult[] = []
	const errors: Array<{ ref: ContentRef; error: string }> = []
	for (const ref of refs) {
		try {
			const result = await resolveSingleRef(ref, task)
			resolved.push(result)
		} catch (err) {
			const errMsg = `ref=${ref.source}:${ref.ref} — ${err instanceof Error ? err.message : String(err)}`
			errors.push({ ref, error: errMsg })
			logError("RESOLVE_REF", `Failed to resolve ${errMsg}`)
		}
	}

	if (resolved.length === 0) {
		const errMsg = `All ${refs.length} ref(s) failed to resolve. First error: ${errors[0]?.error || "unknown"}`
		logError("RESOLVE_REF", errMsg, { errorCount: errors.length })
		throw new Error(errMsg)
	}

	// Log partial failures
	if (errors.length > 0) {
		logCrt(
			"RESOLVE_REF",
			`${errors.length}/${refs.length} ref(s) failed, using ${resolved.length} resolved fragment(s)`,
			{
				errors: errors.map((e) => e.error),
			},
		)
	}

	// Apply transforms
	const contents = resolved.map((r) => r.content)
	const transformed = applyMultiTransform(contents, refMeta.transform)

	const confidence = resolved.reduce((min, r) => Math.min(min, r.confidence), 1.0)

	successCrt(
		"RESOLVE_REF",
		`resolved ${resolved.length}/${refs.length} ref(s), confidence=${confidence.toFixed(2)}`,
		{
			contentLength: (transformed.joined ?? transformed.contents[0] ?? "").length,
			confidence,
			methods: resolved.map((r) => r.method),
		},
	)

	return {
		content: transformed.joined ?? transformed.contents[0] ?? "",
		joined: transformed.joined,
		resolved,
		confidence,
	}
}

// ─── Source Dispatcher ──────────────────────────────────────────────────────

/**
 * Dispatch a single ContentRef to the appropriate source resolver.
 */
async function resolveSingleRef(ref: ContentRef, task: Task): Promise<SelectorResult> {
	switch (ref.source) {
		case "chat":
			return resolveChatSource(ref, task)
		case "file":
			return resolveFileSource(ref, task)
		case "terminal":
			return resolveTerminalSource(ref, task)
		case "tool":
			return resolveToolSource(ref, task)
		default:
			throw new Error(`Unknown content source: ${ref.source}`)
	}
}

/**
 * Resolve all {{ref:...}} markers within a single string.
 * Pattern: {{ref:source=chat,ref=-1,startAnchor=...,endAnchor=...}}
 */
export async function resolveInlineRefs(text: string, task: Task): Promise<string> {
	const REF_PATTERN = /\{\{ref:(.*?)\}\}/
	if (!REF_PATTERN.test(text)) {
		return text
	}

	const globalPattern = /\{\{ref:(.*?)\}\}/g
	const markers: Array<{ match: string; paramsStr: string; index: number }> = []
	let m: RegExpExecArray | null
	while ((m = globalPattern.exec(text)) !== null) {
		markers.push({ match: m[0], paramsStr: m[1], index: m.index })
	}

	if (markers.length === 0) {
		return text
	}

	info("INLINE_REFS", `resolveInlineRefs: ${markers.length} marker(s) found in text (length=${text.length})`)

	let result = text
	for (let i = markers.length - 1; i >= 0; i--) {
		const { match, paramsStr, index } = markers[i]

		const params: Record<string, string> = {}
		for (const part of paramsStr.split(",")) {
			const eqIdx = part.indexOf("=")
			if (eqIdx === -1) continue
			params[part.slice(0, eqIdx).trim()] = part.slice(eqIdx + 1).trim()
		}

		try {
			const content = await resolveRef(
				{
					ref: {
						source: (params.source || "chat") as any,
						ref: params.ref || "-1",
						startAnchor: params.startAnchor || undefined,
						endAnchor: params.endAnchor || undefined,
						selector: params.selector || undefined,
					},
				},
				task,
			)

			result = result.slice(0, index) + content.content + result.slice(index + match.length)
		} catch (err) {
			logError("INLINE_REFS", `Failed to resolve inline ref: ${match}`, { error: String(err) })
			console.error(`[CRT] Failed to resolve inline ref: ${match}`, err)
		}
	}
	return result
}

/**
 * Recursively scan an object (or array/string) and resolve any {{ref:...}} markers.
 */
export async function resolveInlineRefsInObject(obj: any, task: Task): Promise<any> {
	if (!obj) {
		return obj
	}

	if (typeof obj === "string") {
		return resolveInlineRefs(obj, task)
	}

	if (Array.isArray(obj)) {
		info("INLINE_REFS", `resolveInlineRefsInObject: scanning array of ${obj.length} items`)
		const result = []
		for (const item of obj) {
			result.push(await resolveInlineRefsInObject(item, task))
		}
		return result
	}

	if (typeof obj === "object") {
		const keys = Object.keys(obj)
		info("INLINE_REFS", `resolveInlineRefsInObject: scanning object with ${keys.length} keys`)
		const result: any = {}
		for (const key of keys) {
			result[key] = await resolveInlineRefsInObject(obj[key], task)
		}
		return result
	}

	return obj
}

/**
 * Zonal CRT Debug Logger (legacy — delegates to superDebug.logCrt)
 * Appends diagnostic logs to a crt-debug.log file in the workspace root (task.cwd).
 *
 * @deprecated Use superDebug's logCrt() / info() / successCrt() directly instead.
 */
export function logCrtDebug(task: Task, message: string): void {
	try {
		logCrt("CRT_DEBUG", message, { taskId: task.taskId })
	} catch (err) {
		// Fallback to old behavior if superDebug is not available
		try {
			const logDir = task.cwd
			if (!logDir) return
			const logPath = path.join(logDir, "crt-debug.log")
			const timestamp = new Date().toISOString()
			const formattedMessage = `[${timestamp}] ${message}\n`
			fs.appendFileSync(logPath, formattedMessage, "utf8")
		} catch (fallbackErr) {
			console.error("[CRT Debug Logger] Failed to write log:", fallbackErr)
		}
	}
}
