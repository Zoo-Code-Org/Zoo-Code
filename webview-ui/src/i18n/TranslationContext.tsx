import React, { createContext, useContext, ReactNode, useEffect, useCallback } from "react"
import { useTranslation } from "react-i18next"
import i18next, { FALLBACK_LANGUAGE, loadLanguage } from "./setup"
import { useExtensionState } from "@/context/ExtensionStateContext"

// Create context for translations
export const TranslationContext = createContext<{
	t: (key: string, options?: Record<string, any>) => string
	i18n: typeof i18next
}>({
	t: (key: string) => key,
	i18n: i18next,
})

// Translation provider component
const TranslationProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
	// Initialize with default configuration
	const { i18n } = useTranslation()
	// Get the extension state directly - it already contains all state properties
	const extensionState = useExtensionState()
	const language = extensionState.language || FALLBACK_LANGUAGE

	// Only the fallback locale ships in the entry chunk, so any other language
	// has to fetch its bundles before i18next can resolve a key. Switching after
	// the fetch is deliberate: `changeLanguage` is what emits `languageChanged`,
	// the event `useTranslation` subscribes to for re-renders. Until it fires the
	// subtree keeps resolving keys through whichever language is still active:
	// `fallbackLng` on a cold start, the previous language on a warm switch
	// between two non-English locales. The swap-then-render shape is the same one
	// this provider had when every locale was bundled.
	useEffect(() => {
		let cancelled = false

		void loadLanguage(language).then(() => {
			if (!cancelled) {
				void i18n.changeLanguage(language)
			}
		})

		return () => {
			cancelled = true
		}
	}, [i18n, language])

	// Memoize the translation function to prevent unnecessary re-renders
	const translate = useCallback(
		(key: string, options?: Record<string, any>) => {
			return i18n.t(key, options)
		},
		[i18n],
	)

	return (
		<TranslationContext.Provider
			value={{
				t: translate,
				i18n,
			}}>
			{children}
		</TranslationContext.Provider>
	)
}

// Custom hook for easy translations
export const useAppTranslation = () => useContext(TranslationContext)

export default TranslationProvider
