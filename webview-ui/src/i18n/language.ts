import type { i18n } from "i18next"

/**
 * Switch `instance` to `language` unless it is already active.
 *
 * Call it before the state that carries the language is rendered (the "state" message handler), so
 * components mounting in that commit render the new language instead of catching up afterwards.
 * Catching up is not reliable: under StrictMode, react-i18next's `useTranslation` resets a freshly
 * mounted component's `t` to its first identity, and React Compiler then serves the cached output.
 */
export function applyLanguage(instance: i18n, language: string | undefined) {
	if (language && instance.language !== language) {
		void instance.changeLanguage(language)
	}
}
