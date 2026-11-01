import { useCallback, useState } from "react"
import type { HistoryItem } from "@roo-code/types"

import { AutosizeTextarea } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { cn } from "@/lib/utils"
import { vscode } from "@/utils/vscode"

import { getTaskDisplayTitle } from "./types"

type TaskTitleEditorProps = {
	item: Pick<HistoryItem, "id" | "task" | "title">
	onDone: () => void
	className?: string
}

// Titles are a single line: line breaks and repeated whitespace collapse to one space.
const normalizeTitle = (text: string) => text.replace(/\s+/g, " ").trim()

/**
 * Inline editor for renaming a history item. Enter saves, Escape or blur cancels.
 * Saving a blank value, or the original prompt, clears the custom title.
 *
 * It wraps instead of scrolling sideways so a long title stays readable at narrow widths.
 */
export const TaskTitleEditor = ({ item, onDone, className }: TaskTitleEditorProps) => {
	const { t } = useAppTranslation()
	const [value, setValue] = useState(() => normalizeTitle(getTaskDisplayTitle(item)))

	const save = useCallback(() => {
		const normalized = normalizeTitle(value)
		const nextTitle = normalized && normalized !== normalizeTitle(item.task) ? normalized : undefined

		if (nextTitle !== item.title) {
			vscode.postMessage({ type: "renameTaskWithId", taskId: item.id, text: nextTitle ?? "" })
		}

		onDone()
	}, [value, item, onDone])

	// Let keydown keep bubbling: VS Code's webview host listens on `window` to run
	// clipboard and undo shortcuts, so stopping propagation breaks paste (Cmd/Ctrl+V).
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === "Enter") {
				// IME users press Enter to confirm a conversion candidate, not to save.
				if (e.nativeEvent.isComposing || e.keyCode === 229) {
					return
				}
				e.preventDefault()
				save()
			} else if (e.key === "Escape") {
				e.preventDefault()
				onDone()
			}
		},
		[save, onDone],
	)

	return (
		<AutosizeTextarea
			data-testid="task-title-input"
			aria-label={t("history:renameTask")}
			placeholder={normalizeTitle(item.task)}
			value={value}
			rows={1}
			minHeight={20}
			maxHeight={120}
			autoFocus
			onFocus={(e) => e.currentTarget.select()}
			onChange={(e) => setValue(e.target.value)}
			onKeyDown={handleKeyDown}
			onBlur={onDone}
			onClick={(e) => e.stopPropagation()}
			className={cn(
				"flex-1 min-w-0 resize-none border rounded-md px-2 py-1 text-base select-text break-words",
				className,
			)}
		/>
	)
}
