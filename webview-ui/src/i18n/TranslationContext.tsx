import React, {
	createContext,
	useContext,
	ReactNode,
	useEffect,
	useCallback,
	useMemo,
	useSyncExternalStore,
} from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { FALLBACK_LANGUAGE, loadLanguage } from "./setup"
import { useExtensionState } from "@/context/ExtensionStateContext"

export type TranslationContextValue = {
	t: TFunction
	/** The language i18next is rendering, which trails the requested one until its bundles load. */
	language: string
}

// Create context for translations. Without a provider (isolated component tests) keys render as-is.
export const TranslationContext = createContext<TranslationContextValue>({
	t: ((key: string) => key) as TFunction,
	language: FALLBACK_LANGUAGE,
})

// Translation provider component
const TranslationProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
	// Initialize with default configuration
	const { i18n } = useTranslation()
	// Get the extension state directly - it already contains all state properties
	const extensionState = useExtensionState()
	const requestedLanguage = extensionState.language || FALLBACK_LANGUAGE

	// Only the fallback locale ships in the entry chunk, so any other language
	// has to fetch its bundles before i18next can resolve a key. Switching after
	// the fetch is deliberate: until `changeLanguage` runs, the subtree keeps
	// rendering whichever language is still active (`fallbackLng` on a cold
	// start, the previous language on a warm switch) instead of English keys
	// under the new language. A newer request cancels a fetch still in flight.
	useEffect(() => {
		let cancelled = false

		void loadLanguage(requestedLanguage).then(() => {
			if (!cancelled) {
				void i18n.changeLanguage(requestedLanguage)
			}
		})

		return () => {
			cancelled = true
		}
	}, [i18n, requestedLanguage])

	const subscribe = useCallback(
		(onLanguageChanged: () => void) => {
			i18n.on("languageChanged", onLanguageChanged)

			return () => i18n.off("languageChanged", onLanguageChanged)
		},
		[i18n],
	)

	const language = useSyncExternalStore(subscribe, () => i18n.language)

	// `t` is bound to the active language, so its identity changes exactly when the language does.
	// Memoized consumers (and React Compiler caches) depend on `t`, so they re-render on a switch
	// instead of serving output translated in the previous language.
	const value = useMemo(() => ({ t: i18n.getFixedT(language), language }), [i18n, language])

	return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>
}

// Custom hook for easy translations
export const useAppTranslation = () => useContext(TranslationContext)

export default TranslationProvider
