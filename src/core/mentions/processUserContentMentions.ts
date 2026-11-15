import Anthropic from "@anthropic-ai/sdk"
import type { MentionSegment } from "@roo-code/types"

import { parseMentions, MentionContentBlock } from "./index"
import { FileContextTracker } from "../context-tracking/FileContextTracker"
import type { SkillLookup } from "../../services/skills/skillInvocation"

type TextPart = Anthropic.Messages.TextBlockParam

/** Wraps segments in the `<user_message>` tags. The tags are generated text. */
export function wrapUserMessage(segments: MentionSegment[]): MentionSegment[] {
	return [
		{ text: "<user_message>\n", source: "generated" },
		...segments,
		{ text: "\n</user_message>", source: "generated" },
	]
}

export interface ExpandUserMentionsResult {
	content: TextPart[]
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
 * Expand mentions in the user segments only. Call it where user input enters the task.
 * Generated segments pass through unchanged.
 */
export async function expandUserMentions({
	segments,
	cwd,
	fileContextTracker,
	rooIgnoreController,
	showRooIgnoredFiles = false,
	includeDiagnosticMessages = true,
	maxDiagnosticMessages = 50,
	skillsManager,
	currentMode = "code",
}: {
	segments: MentionSegment[]
	cwd: string
	fileContextTracker: FileContextTracker
	rooIgnoreController?: any
	showRooIgnoredFiles?: boolean
	includeDiagnosticMessages?: boolean
	maxDiagnosticMessages?: number
	skillsManager?: SkillLookup
	currentMode?: string
}): Promise<ExpandUserMentionsResult> {
	let commandMode: string | undefined
	let text = ""
	const extra: TextPart[] = []

	for (const segment of segments) {
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
			extra.push({ type: "text", text: result.slashCommandHelp })
		}
	}

	return { content: [{ type: "text", text }, ...extra], mode: commandMode }
}
