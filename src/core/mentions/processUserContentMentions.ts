import Anthropic from "@anthropic-ai/sdk"
import type { MentionSegment } from "@roo-code/types"

import { parseMentions, MentionContentBlock } from "./index"
import { FileContextTracker } from "../context-tracking/FileContextTracker"
import type { SkillLookup } from "../../services/skills/skillInvocation"

// Internal aliases for the Anthropic content block subtypes used during processing.
type TextPart = Anthropic.Messages.TextBlockParam
type ImagePart = Anthropic.Messages.ImageBlockParam

// Origin labels stay in memory and cannot be forged by message text or restored history.
const segmentedBlocks = new WeakMap<TextPart, { text: string; segments: MentionSegment[] }>()

/** Call only at a user-input boundary. Only `user` segments may have mentions expanded. */
export function userMentionContent(segments: MentionSegment[]): TextPart {
	const text = segments.map((s) => s.text).join("")
	const block: TextPart = { type: "text", text }
	segmentedBlocks.set(block, { text, segments })
	return block
}

/** Wraps segments in the `<user_message>` tags. The tags are generated text. */
export function wrapUserMessage(segments: MentionSegment[]): MentionSegment[] {
	return [
		{ text: "<user_message>\n", source: "generated" },
		...segments,
		{ text: "\n</user_message>", source: "generated" },
	]
}

export interface ProcessUserContentMentionsResult {
	content: Anthropic.Messages.ContentBlockParam[]
	mode?: string // Mode from the first slash command that has one
}

/**
 * Converts MentionContentBlocks to TextPart blocks.
 * Each file/folder mention becomes a separate text block formatted
 * to look like a read_file tool result.
 */
function contentBlocksToTextParts(contentBlocks: MentionContentBlock[]): TextPart[] {
	return contentBlocks.map((block) => ({
		type: "text" as const,
		text: block.content,
	}))
}

/**
 * Process mentions only in explicitly authorized user input.
 *
 * File/folder @ mentions are now returned as separate text blocks that
 * look like read_file tool results, making it clear to the model that
 * the file has already been read.
 */
export async function processUserContentMentions({
	userContent,
	cwd,
	fileContextTracker,
	rooIgnoreController,
	showRooIgnoredFiles = false,
	includeDiagnosticMessages = true,
	maxDiagnosticMessages = 50,
	skillsManager,
	currentMode = "code",
}: {
	userContent: Anthropic.Messages.ContentBlockParam[]
	cwd: string
	fileContextTracker: FileContextTracker
	rooIgnoreController?: any
	showRooIgnoredFiles?: boolean
	includeDiagnosticMessages?: boolean
	maxDiagnosticMessages?: number
	skillsManager?: SkillLookup
	currentMode?: string
}): Promise<ProcessUserContentMentionsResult> {
	// Track the first mode found from slash commands
	let commandMode: string | undefined

	// Process userContent array, which contains text and image parts.
	// Tool results and unmarked text never authorize resource access.
	const content = (
		await Promise.all(
			userContent.map(async (block) => {
				if (block.type === "text") {
					const labeled = segmentedBlocks.get(block)
					if (labeled && labeled.text === block.text) {
						let text = ""
						const extra: TextPart[] = []
						for (const segment of labeled.segments) {
							if (segment.source !== "user") {
								text += segment.text
								continue
							}
							const result = await parseMentions(
								segment.text,
								cwd,
								fileContextTracker,
								rooIgnoreController,
								showRooIgnoredFiles,
								includeDiagnosticMessages,
								maxDiagnosticMessages,
								skillsManager,
								currentMode,
							)
							// Capture the first mode found
							if (!commandMode && result.mode) {
								commandMode = result.mode
							}
							text += result.text
							// File/folder content as separate blocks (formatted like read_file results)
							extra.push(...contentBlocksToTextParts(result.contentBlocks))
							if (result.slashCommandHelp) {
								extra.push({ type: "text" as const, text: result.slashCommandHelp })
							}
						}
						const blocks: Array<TextPart | ImagePart> = [{ ...block, text }, ...extra]
						return blocks
					}

					return block
				}

				// Legacy backward compat: tool_result / tool-result blocks from older formats
				// are passed through unchanged (tool results are now in separate RooToolMessages).
				return block
			}),
		)
	).flat()

	return { content: content as Anthropic.Messages.ContentBlockParam[], mode: commandMode }
}
