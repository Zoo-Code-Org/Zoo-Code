import { Check } from "lucide-react"
import type { ModelRecord, ProviderName } from "@roo-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { cn } from "@/lib/utils"
import { useModelSearch } from "./useModelSearch"
import { pickerResultsClassName } from "./pickerNavigation"

interface ModelResultsProps {
	models: ModelRecord | null
	selectedId: string | undefined
	search: string
	provider: ProviderName | undefined
	allowCustomArn: boolean
	isLoading: boolean
	isError: boolean
	settingsOnly: boolean
	disabled: boolean
	onSelect: (id: string) => void
	onRetry: () => void
	onSettings: () => void
}

export function ModelResults(props: ModelResultsProps) {
	const { t } = useAppTranslation()
	const {
		models,
		selectedId,
		search,
		provider,
		allowCustomArn,
		isLoading,
		isError,
		settingsOnly,
		disabled,
		onSelect,
		onRetry,
		onSettings,
	} = props
	const results = useModelSearch(models, selectedId, search, provider, allowCustomArn)
	return (
		<div
			role="group"
			aria-label={t("chat:modelPicker.providerModels")}
			aria-busy={isLoading}
			className={cn(pickerResultsClassName, "py-1")}>
			{isLoading ? (
				<div role="status" className="px-3 py-2 text-xs text-vscode-descriptionForeground">
					{t("chat:modelSelector.loading")}
				</div>
			) : isError ? (
				<div role="alert" className="px-3 py-2 text-xs text-vscode-descriptionForeground">
					{t("chat:error")}
					<button
						type="button"
						onClick={onRetry}
						disabled={disabled}
						className="ml-2 cursor-pointer rounded border border-vscode-input-border bg-transparent px-2 py-1 text-vscode-foreground focus-visible:ring-1 focus-visible:ring-vscode-focusBorder">
						{t("chat:retry.title")}
					</button>
				</div>
			) : settingsOnly ? (
				<div className="px-3 py-2 text-xs text-vscode-descriptionForeground">
					{t("chat:modelPicker.modelSettingsHint")}
				</div>
			) : results.length === 0 ? (
				<div role="status" className="px-3 py-2 text-xs text-vscode-descriptionForeground">
					{t("common:ui.no_results")}
				</div>
			) : (
				results.map(({ id, info }) => (
					<button
						key={id}
						type="button"
						data-picker-result
						disabled={disabled}
						aria-pressed={id === selectedId}
						onClick={() => onSelect(id)}
						className={cn(
							"flex w-full cursor-pointer items-center gap-2 border-none px-3 py-1.5 text-left text-sm text-vscode-foreground hover:bg-vscode-list-hoverBackground focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder disabled:opacity-50",
							id === selectedId
								? "bg-vscode-list-activeSelectionBackground text-vscode-list-activeSelectionForeground"
								: "bg-transparent",
						)}>
						<span className="min-w-0 flex-1 truncate" title={id}>
							{info.displayName ?? id}
						</span>
						{id === selectedId && <Check aria-hidden="true" className="size-3 shrink-0" />}
					</button>
				))
			)}
			{!isLoading && (settingsOnly || isError || results.length === 0) && (
				<button
					type="button"
					onClick={onSettings}
					className="mx-3 my-2 cursor-pointer rounded border border-vscode-input-border bg-transparent px-2 py-1 text-xs text-vscode-foreground focus-visible:ring-1 focus-visible:ring-vscode-focusBorder">
					{t("chat:modelSelector.settings")}
				</button>
			)}
		</div>
	)
}
