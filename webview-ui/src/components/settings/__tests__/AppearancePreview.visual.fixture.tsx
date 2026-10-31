import { AppearancePreview } from "../AppearancePreview"
import { AppProviders } from "../../../../playwright/AppProviders"

/**
 * Two previews, one above the other:
 *  - "set": explicit sizes, so the stepper values show up in the sample.
 *  - "reset": every value unset while <html> carries saved values. The preview must ignore the saved
 *    values (a reset shows before Save) and fall back to VS Code's sizes, like the live UI does.
 */
export function AppearancePreviewStory() {
	return (
		<AppProviders>
			<div
				data-testid="appearance-preview-story"
				className="flex w-[420px] flex-col gap-4 rounded-lg border border-vscode-panel-border bg-vscode-editor-background p-4 text-vscode-editor-foreground">
				<div data-testid="appearance-preview-set">
					<AppearancePreview
						values={{
							interfaceFontScale: 120,
							terminalFontSize: 18,
							editorFontSize: 16,
							spacingScale: 150,
						}}
						chatFontSize={15}
					/>
				</div>
				<div data-testid="appearance-preview-reset">
					<AppearancePreview values={{}} />
				</div>
			</div>
		</AppProviders>
	)
}
