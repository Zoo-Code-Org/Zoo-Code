/**
 * User-configurable appearance settings: interface text scale, terminal and
 * editor (code) font sizes, and spacing scale.
 *
 * Each value maps to one CSS custom property on <html>; index.css owns the
 * defaults and every consumer, so components never read these settings.
 * Unset (undefined/null) removes the override and restores the default.
 */

export interface AppearanceSetting {
	min: number
	max: number
	step: number
	/** Value shown in the stepper when the setting is unset. */
	fallback: number
	unit: "%" | "px"
	cssVar: string
	toCss: (value: number) => string
}

export const APPEARANCE_SETTINGS = {
	interfaceFontScale: {
		min: 50,
		max: 200,
		step: 5,
		fallback: 100,
		unit: "%",
		cssVar: "--zoo-ui-scale",
		toCss: (v) => String(v / 100),
	},
	terminalFontSize: {
		min: 8,
		max: 32,
		step: 1,
		fallback: 12,
		unit: "px",
		cssVar: "--zoo-terminal-font-size",
		toCss: (v) => `${v}px`,
	},
	editorFontSize: {
		min: 8,
		max: 32,
		step: 1,
		fallback: 13,
		unit: "px",
		cssVar: "--zoo-editor-font-size",
		toCss: (v) => `${v}px`,
	},
	spacingScale: {
		min: 50,
		max: 200,
		step: 5,
		fallback: 100,
		unit: "%",
		cssVar: "--zoo-spacing-scale",
		toCss: (v) => String(v / 100),
	},
} satisfies Record<string, AppearanceSetting>

export type AppearanceKey = keyof typeof APPEARANCE_SETTINGS
export type AppearanceValues = Partial<Record<AppearanceKey, number | null | undefined>>

/** Clamps to the setting's range and snaps to an integer; non-finite → undefined. */
export function clampAppearance(key: AppearanceKey, value: number | null | undefined): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined
	const { min, max } = APPEARANCE_SETTINGS[key]
	return Math.min(max, Math.max(min, Math.round(value)))
}

/** Present on <html> while the user has set an editor font size. */
export const EDITOR_FONT_SET_CLASS = "zoo-editor-font-set"

/** Writes (or clears) every appearance CSS variable on `root`. */
export function applyAppearanceVariables(root: HTMLElement, values: AppearanceValues): void {
	for (const key of Object.keys(APPEARANCE_SETTINGS) as AppearanceKey[]) {
		const setting = APPEARANCE_SETTINGS[key]
		const value = clampAppearance(key, values[key])
		if (value === undefined) {
			root.style.removeProperty(setting.cssVar)
		} else {
			root.style.setProperty(setting.cssVar, setting.toCss(value))
		}
		// Lets index.css apply the editor size to the diff view only while it is set.
		if (key === "editorFontSize") root.classList.toggle(EDITOR_FONT_SET_CLASS, value !== undefined)
	}
}
