import { globalSettingsSchema, type RooCodeSettings } from "@roo-code/types"

type ValueSchema = { safeParse(value: unknown): { success: boolean } }

const DISPLAY_SETTING_SCHEMAS = new Map<string, ValueSchema>([
	["timeFormat", globalSettingsSchema.shape.timeFormat],
	["dateFormat", globalSettingsSchema.shape.dateFormat],
	["showRelativeTimes", globalSettingsSchema.shape.showRelativeTimes],
])

/**
 * Whether a value for the display settings or the display language is one that their schemas do not allow. These
 * values reach the formatters, and a message that was written by hand is not bound by the webview's own controls.
 * Any other key is never invalid here.
 */
export const isInvalidDisplayValue = (key: string, value: unknown): boolean =>
	key === "language"
		? !globalSettingsSchema.shape.language.nullish().safeParse(value).success
		: DISPLAY_SETTING_SCHEMAS.get(key)?.safeParse(value).success === false

/**
 * The values of a programmatic write (the public API), without an invalid value for one of the three display
 * settings. The others are kept as they are.
 */
export const withoutInvalidDisplaySettings = (
	values: RooCodeSettings,
	onIgnored: (key: string) => void,
): RooCodeSettings =>
	Object.fromEntries(
		Object.entries(values).filter(([key, value]) => {
			const invalid = DISPLAY_SETTING_SCHEMAS.get(key)?.safeParse(value).success === false
			if (invalid) onIgnored(key)
			return !invalid
		}),
	)
