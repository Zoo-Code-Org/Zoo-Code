import { z } from "zod"

/**
 * Interface for follow-up data structure used in follow-up questions
 * This represents the data structure for follow-up questions that the LLM can ask
 * to gather more information needed to complete a task.
 */
export interface FollowUpData {
	/** The question being asked by the LLM */
	question?: string
	/** Array of suggested answers that the user can select */
	suggest?: Array<SuggestionItem>
}

/**
 * Interface for a suggestion item with optional mode switching
 */
export interface SuggestionItem {
	/** The text of the suggestion */
	answer: string
	/** Optional mode to switch to when selecting this suggestion */
	mode?: string
}

export const getSuggestionMode = (mode: unknown): string | undefined => {
	if (typeof mode === "string" && mode.trim().length > 0) {
		return mode.trim()
	}

	if (mode && typeof mode === "object" && "mode_slug" in mode) {
		const modeSlug = (mode as { mode_slug?: unknown }).mode_slug
		return typeof modeSlug === "string" && modeSlug.trim().length > 0 ? modeSlug.trim() : undefined
	}

	return undefined
}

/**
 * Zod schema for SuggestionItem
 */
export const suggestionItemSchema = z.object({
	answer: z.string(),
	mode: z.string().optional(),
})

/**
 * Zod schema for FollowUpData
 */
export const followUpDataSchema = z.object({
	question: z.string().optional(),
	suggest: z.array(suggestionItemSchema).optional(),
})

export type FollowUpDataType = z.infer<typeof followUpDataSchema>
