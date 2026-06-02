/**
 * Content Reference Tool — ResolveRef Orchestrator
 *
 * Main entry point for content reference resolution. Processes a ContentRefParams
 * by dispatching to the appropriate source resolver (chat, file, terminal, tool),
 * then applies the transform pipeline to the resolved content.
 */

import type { ContentRefParams, ContentRef } from "../../../shared/tools"
import type { SelectorResult } from "./selector"
import { resolveContentRef } from "./selector"
import { applyTransform, applyMultiTransform } from "./transform"
import { resolveChatSource } from "./sources/chat"
import { resolveFileSource } from "./sources/file"
import { resolveTerminalSource } from "./sources/terminal"
import { resolveToolSource } from "./sources/tool"
import type { Task } from "../../task/Task"

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

	if (refMeta.multi_ref && refMeta.multi_ref.length > 0) {
		refs.push(...refMeta.multi_ref)
	} else if (refMeta.ref) {
		refs.push(refMeta.ref)
	}

	if (refs.length === 0) {
		throw new Error("No ref or multi_ref specified in refMeta.")
	}

	// Resolve all refs
	const resolved: SelectorResult[] = []
	for (const ref of refs) {
		const result = await resolveSingleRef(ref, task)
		resolved.push(result)
	}

	// Apply transforms
	const contents = resolved.map((r) => r.content)
	const transformed = applyMultiTransform(contents, refMeta.transform)

	return {
		content: transformed.joined ?? transformed.contents[0] ?? "",
		joined: transformed.joined,
		resolved,
		confidence: resolved.reduce((min, r) => Math.min(min, r.confidence), 1.0),
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
