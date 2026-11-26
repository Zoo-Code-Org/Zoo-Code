import { useAppTranslation } from "@src/i18n/TranslationContext"

export function InstructionRefreshWarningRow({ failureText }: { failureText?: string }) {
	const { t } = useAppTranslation()

	return (
		<div className="flex flex-col gap-1" role="status" aria-live="polite">
			<div className="flex items-center gap-2">
				<span className="codicon codicon-warning text-vscode-editorWarning-foreground" aria-hidden="true" />
				<span className="font-bold text-vscode-foreground">{t("chat:instructionRefresh.warningHeader")}</span>
			</div>
			<span className="text-sm text-vscode-descriptionForeground">
				{t("chat:instructionRefresh.description")}
			</span>
			{failureText && (
				<span className="whitespace-pre-wrap break-words text-sm text-vscode-descriptionForeground">
					{failureText}
				</span>
			)}
		</div>
	)
}
