export { DEFAULT_MODES } from "../../packages/types/src/mode"

export const DEFAULT_AUTO_CLOSE_ZOO_OPENED_FILES = false
export const DEFAULT_AUTO_CLOSE_ZOO_OPENED_FILES_AFTER_USER_EDITED = false
export const DEFAULT_AUTO_CLOSE_ZOO_OPENED_NEW_FILES = false

export const CODEBASE_INDEX_DEFAULTS = {
	MIN_SEARCH_RESULTS: 10,
	MAX_SEARCH_RESULTS: 200,
	DEFAULT_SEARCH_RESULTS: 50,
	SEARCH_RESULTS_STEP: 10,
	MIN_SEARCH_SCORE: 0,
	MAX_SEARCH_SCORE: 1,
	DEFAULT_SEARCH_MIN_SCORE: 0.4,
	SEARCH_SCORE_STEP: 0.05,
} as const

export const TelemetryEventName = {
	MODE_SWITCH: "Mode Switched",
	MODE_SELECTOR_OPENED: "Mode Selector Opened",
} as const

export const OpenAiServiceTier = {
	Default: "default",
	Flex: "flex",
	Priority: "priority",
} as const

const languages = [
	"ca",
	"de",
	"en",
	"es",
	"fr",
	"hi",
	"id",
	"it",
	"ja",
	"ko",
	"nl",
	"pl",
	"pt-BR",
	"ru",
	"tr",
	"vi",
	"zh-CN",
	"zh-TW",
]

export const isLanguage = (value: string) => languages.includes(value)
