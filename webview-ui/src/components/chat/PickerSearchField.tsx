import { useRef } from "react"
import { Search, X } from "lucide-react"

import { useAppTranslation } from "@src/i18n/TranslationContext"

interface PickerSearchFieldProps {
	label: string
	value: string
	onChange: (value: string) => void
	disabled?: boolean
}

/** Shared geometry and interactions for the profile and model views of the picker. */
export function PickerSearchField({ label, value, onChange, disabled = false }: PickerSearchFieldProps) {
	const { t } = useAppTranslation()
	const inputRef = useRef<HTMLInputElement>(null)
	return (
		<div className="shrink-0 border-b border-vscode-dropdown-border px-3 py-2">
			<div className="flex items-center gap-2 rounded border border-vscode-input-border bg-vscode-input-background px-2 focus-within:ring-1 focus-within:ring-vscode-focusBorder">
				<Search aria-hidden="true" className="size-3 shrink-0 text-vscode-input-foreground opacity-60" />
				<input
					ref={inputRef}
					aria-label={label}
					placeholder={t("common:ui.search_placeholder")}
					value={value}
					onChange={(event) => onChange(event.target.value)}
					disabled={disabled}
					autoFocus
					className="h-8 w-full min-w-0 border-none bg-transparent text-xs text-vscode-input-foreground outline-none disabled:opacity-50"
				/>
				{value && (
					<button
						type="button"
						aria-label={t("chat:modelPicker.clearSearch")}
						disabled={disabled}
						onClick={() => {
							onChange("")
							inputRef.current?.focus()
						}}
						className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 text-vscode-input-foreground opacity-60 hover:opacity-100 focus-visible:ring-1 focus-visible:ring-vscode-focusBorder disabled:cursor-not-allowed">
						<X aria-hidden="true" className="size-3" />
					</button>
				)}
			</div>
		</div>
	)
}
