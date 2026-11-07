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
	/** Value shown in the stepper when the setting is unset and the rendered default cannot be known. */
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

/** The chat font size the host accepts (`globalSettingsSchema`): an integer from 8 to 32 px. */
export const isChatFontSize = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 8 && value <= 32

/** Clamps to the setting's range and snaps to an integer; non-finite → undefined. */
export function clampAppearance(key: AppearanceKey, value: number | null | undefined): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined
	const { min, max } = APPEARANCE_SETTINGS[key]
	return Math.min(max, Math.max(min, Math.round(value)))
}

/** What the unset defaults of the font sizes follow: VS Code's sizes, and the chat text that the editor size is relative to. */
export interface AppearanceDefaultsContext {
	/** `--vscode-font-size`, in px. */
	vscodeFontSize?: number
	/** `--vscode-editor-font-size`, in px: the terminal follows it while no terminal size is set. */
	vscodeEditorFontSize?: number
	/** The chat font size setting, in px. */
	chatFontSize?: number
	/** The interface scale setting, in %. */
	interfaceFontScale?: number
}

/** The factor of the chat text that code blocks use while no editor font size is set (`CodeBlock`, `AppearancePreview`). */
const EDITOR_DEFAULT_EM = 0.95

/**
 * The size, in the unit of the setting, that the UI renders while the setting is unset: what the stepper shows and
 * steps from, so that the first click moves from the text on screen and not from a fixed number. Falls back to
 * `fallback` when what it follows is not known. Always inside the allowed range.
 */
export function renderedAppearanceDefault(key: AppearanceKey, context: AppearanceDefaultsContext = {}): number {
	const { fallback } = APPEARANCE_SETTINGS[key]
	const known = (value: number | undefined): value is number =>
		typeof value === "number" && Number.isFinite(value) && value > 0
	let rendered = fallback
	if (key === "terminalFontSize" && known(context.vscodeEditorFontSize)) {
		rendered = context.vscodeEditorFontSize
	} else if (key === "editorFontSize") {
		const chat = isChatFontSize(context.chatFontSize) ? context.chatFontSize : context.vscodeFontSize
		if (known(chat)) {
			const scale = known(context.interfaceFontScale) ? context.interfaceFontScale / 100 : 1
			rendered = chat * scale * EDITOR_DEFAULT_EM
		}
	}
	return clampAppearance(key, rendered) ?? fallback
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
