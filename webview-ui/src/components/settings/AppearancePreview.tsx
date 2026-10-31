import type { CSSProperties } from "react"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { APPEARANCE_SETTINGS, clampAppearance, type AppearanceKey } from "@/utils/appearance"

interface AppearancePreviewProps {
	values: Partial<Record<AppearanceKey, number | undefined>>
	chatFontSize?: number
}

/**
 * Live preview of the appearance settings using the *unsaved* values.
 *
 * It sets the same CSS custom properties the real UI reads, but only on this
 * element, so the sample updates on every stepper click without touching the
 * rest of the webview until the user presses Save.
 */
export const AppearancePreview = ({ values, chatFontSize }: AppearancePreviewProps) => {
	const { t } = useAppTranslation()

	// Custom properties inherit, and the saved values live on <html>. An unset value is therefore set
	// to `initial` (the guaranteed-invalid value) rather than left out: leaving it out would inherit
	// the saved value, so a reset would not show in the preview until after Save. `initial` makes
	// var() fall through to the same fallback the live UI uses (e.g. the terminal follows VS Code's
	// editor font size), so the preview never shows a size the chat would not.
	const vars: Record<string, string> = {}
	for (const key of Object.keys(APPEARANCE_SETTINGS) as AppearanceKey[]) {
		const setting = APPEARANCE_SETTINGS[key]
		const v = clampAppearance(key, values[key])
		vars[setting.cssVar] = v === undefined ? "initial" : setting.toCss(v)
	}
	vars["--zoo-chat-font-size"] = chatFontSize ? `${chatFontSize}px` : "initial"

	const uiText: CSSProperties = {
		fontSize: "calc(var(--zoo-chat-font-size, var(--vscode-font-size)) * var(--zoo-ui-scale, 1))",
	}
	const row: CSSProperties = {
		padding: "calc(10px * var(--zoo-spacing-scale, 1)) calc(15px * var(--zoo-spacing-scale, 1))",
	}
	const mono: CSSProperties = {
		fontFamily: "var(--vscode-editor-font-family, monospace)",
		margin: 0,
		padding: "6px 10px",
		borderRadius: 4,
		overflowX: "auto",
		whiteSpace: "pre",
	}

	return (
		<div
			className="rounded-md border border-vscode-panel-border bg-vscode-editor-background overflow-hidden"
			style={vars as CSSProperties}
			aria-label={t("settings:ui.appearance.preview")}
			data-testid="appearance-preview">
			<div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-vscode-descriptionForeground border-b border-vscode-panel-border">
				{t("settings:ui.appearance.preview")}
			</div>

			<div style={{ ...row, ...uiText }} className="border-b border-vscode-panel-border">
				<div className="text-vscode-descriptionForeground mb-1" style={{ fontSize: "0.85em" }}>
					{t("settings:ui.appearance.sample.you")}
				</div>
				<div>{t("settings:ui.appearance.sample.user")}</div>
			</div>

			<div style={{ ...row, ...uiText }}>
				<div className="text-vscode-descriptionForeground mb-1" style={{ fontSize: "0.85em" }}>
					{t("settings:ui.appearance.sample.zoo")}
				</div>
				<div className="mb-2">{t("settings:ui.appearance.sample.assistant")}</div>

				<div className="text-[11px] text-vscode-descriptionForeground mb-1">
					{t("settings:ui.appearance.editorFontSize.label")}
				</div>
				<pre
					className="bg-vscode-textCodeBlock-background mb-2"
					// Same fallback as CodeBlock: relative to the chat text when no editor size is set.
					style={{ ...mono, fontSize: "var(--zoo-editor-font-size, 0.95em)" }}>
					{'const isLoading = status === "saving"'}
				</pre>

				<div className="text-[11px] text-vscode-descriptionForeground mb-1">
					{t("settings:ui.appearance.terminalFontSize.label")}
				</div>
				<pre
					style={{
						...mono,
						fontSize: "var(--zoo-terminal-font-size, var(--vscode-editor-font-size, 13px))",
						background: "var(--vscode-terminal-background, var(--vscode-textCodeBlock-background))",
						color: "var(--vscode-terminal-foreground, inherit)",
					}}>
					{"$ pnpm test\n✓ 42 passed"}
				</pre>
			</div>
		</div>
	)
}
