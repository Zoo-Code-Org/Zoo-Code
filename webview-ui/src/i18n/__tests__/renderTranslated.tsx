import React from "react"
import { act, waitFor } from "@testing-library/react"

import i18next from "@src/i18n/setup"
import TranslationProvider from "@src/i18n/TranslationContext"

import {
	makeExtensionState,
	renderWithExtensionState,
	type RenderWithExtensionStateOptions,
} from "@src/utils/test-utils"

/**
 * Post a "state" message the way the extension host does. TranslationProvider picks up the
 * language from it, so this drives a UI language change through the real switching path.
 */
export const postExtensionState = (state: Record<string, unknown>) =>
	act(async () => {
		window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state } }))
	})

/**
 * Render `ui` under the real TranslationProvider (kept out of test-utils so specs that mock
 * react-i18next do not load i18next). `setLanguage` resolves once i18next renders the new language.
 */
export const renderTranslated = (
	ui: React.ReactElement,
	{ state, ...options }: RenderWithExtensionStateOptions = {},
) => {
	const result = renderWithExtensionState(<TranslationProvider>{ui}</TranslationProvider>, {
		state: makeExtensionState(state),
		...options,
	})

	const setLanguage = async (language: string) => {
		await postExtensionState({ language })
		await waitFor(() => expect(i18next.language).toBe(language))
	}

	// Keep the provider around a rerendered `ui` so the rerender does not remount the subtree.
	const rerender = (next: React.ReactElement) => result.rerender(<TranslationProvider>{next}</TranslationProvider>)

	return { ...result, rerender, setLanguage }
}
