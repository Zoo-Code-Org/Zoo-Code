import Anthropic from "@anthropic-ai/sdk"

import { parseMentions, MentionContentBlock } from "./index"
import { FileContextTracker } from "../context-tracking/FileContextTracker"
import type { SkillLookup } from "../../services/skills/skillInvocation"

// Internal aliases for the Anthropic content block subtypes used during processing.
type TextPart = Anthropic.Messages.TextBlockParam
type ImagePart = Anthropic.Messages.ImageBlockParam

// Authorization stays in memory and cannot be forged by message text or restored history.
const authorizedInputs = new WeakMap<TextPart, { text: string; input: string }>()

/** Call only at a user-input boundary, before adding lower-trust context. */
export function userMentionContent(text: string, input: string = text): TextPart {
	const block: TextPart = { type: "text", text }
	if (input && text.includes(input)) authorizedInputs.set(block, { text, input })
	return block
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
					const authorized = authorizedInputs.get(block)
					if (authorized && authorized.text === block.text) {
						const result = await parseMentions(
							authorized.input,
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

						// Build the blocks array:
						// 1. User's text (with @ mentions replaced by clean paths)
						// 2. File/folder content blocks (formatted like read_file results)
						// 3. Slash command help (if any)
						const blocks: Array<TextPart | ImagePart> = [
							{
								...block,
								text: block.text.replace(authorized.input, () => result.text),
							},
						]

						// Add file/folder content as separate blocks
						if (result.contentBlocks.length > 0) {
							blocks.push(...contentBlocksToTextParts(result.contentBlocks))
						}

						if (result.slashCommandHelp) {
							blocks.push({
								type: "text" as const,
								text: result.slashCommandHelp,
							})
						}
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
