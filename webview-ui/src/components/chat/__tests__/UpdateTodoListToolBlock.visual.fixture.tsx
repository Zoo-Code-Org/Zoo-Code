/* v8 ignore file -- Playwright component fixture is covered by the visual test. */
import React from "react"

import { TranslationContext } from "@src/i18n/TranslationContext"
import { createFixtureTranslation } from "@src/i18n/__tests__/createFixtureI18n.visual.i18n"
import chatEn from "@/i18n/locales/en/chat.json"

function flattenTranslations(obj: Record<string, unknown>, prefix: string): Record<string, string> {
	const result: Record<string, string> = {}
	for (const [key, value] of Object.entries(obj)) {
		const fullKey = `${prefix}${key}`
		if (typeof value === "string") {
			result[fullKey] = value
		} else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			Object.assign(result, flattenTranslations(value as Record<string, unknown>, `${fullKey}.`))
		}
	}
	return result
}

// Serve the English `chat:todo.*` strings so the todo controls keep their real labels in snapshots
const translation = createFixtureTranslation(flattenTranslations(chatEn.todo, "chat:todo."))

export const EnglishChatTranslations = ({ children }: { children: React.ReactNode }) => (
	<TranslationContext.Provider value={translation}>{children}</TranslationContext.Provider>
)
