import { createContext, useContext } from "react"

type TranslationContextValue = {
	t: (key: string, options?: Record<string, any>) => string
	i18n: unknown
}

export const TranslationContext = createContext<TranslationContextValue>({
	t: (key: string) => key,
	i18n: null,
})

export const useAppTranslation = () => useContext(TranslationContext)
