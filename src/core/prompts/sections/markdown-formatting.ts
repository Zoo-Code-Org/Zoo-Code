import type { SystemPromptContext } from "../types"
import { isPromptToolAvailable } from "../types"

export function markdownFormattingSection(context?: SystemPromptContext): string {
	const completionReference = isPromptToolAvailable(context, "attempt_completion")
		? " and ALSO those in attempt_completion"
		: ""

	return `====

MARKDOWN RULES

ALL responses MUST show ANY \`language construct\` OR filename reference as clickable, exactly as [\`filename OR language.declaration()\`](relative/file/path.ext:line); line is required for \`syntax\` and optional for filename links. This applies to ALL markdown responses${completionReference}`
}
