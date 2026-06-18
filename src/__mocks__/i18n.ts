import { vi } from "vitest"

export const t = vi.fn((key: string, options?: Record<string, any>) => {
	if (options) {
		return Object.entries(options).reduce((str, [k, v]) => str.replace(new RegExp(`{{${k}}}`, "g"), String(v)), key)
	}
	return key
})

export const initializeI18n = vi.fn()
export const getCurrentLanguage = vi.fn(() => "en")
export const changeLanguage = vi.fn()

export default { t, changeLanguage, language: "en" }
