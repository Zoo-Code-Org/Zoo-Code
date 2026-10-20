import { useCallback, useState } from "react"
import type { HistoryItem } from "@roo-code/types"

import { Input } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { cn } from "@/lib/utils"
import { vscode } from "@/utils/vscode"

import { getTaskDisplayTitle } from "./types"

type TaskTitleEditorProps = {
	item: Pick<HistoryItem, "id" | "task" | "title">
	onDone: () => void
	className?: string
}

/**
 * Inline input for renaming a history item. Enter saves, Escape or blur cancels.
 * Saving a blank value, or the original prompt, clears the custom title.
 */
export const TaskTitleEditor = ({ item, onDone, className }: TaskTitleEditorProps) => {
	const { t } = useAppTranslation()
	const [value, setValue] = useState(() => getTaskDisplayTitle(item))

	const save = useCallback(() => {
		const trimmed = value.trim()
		const nextTitle = trimmed && trimmed !== item.task.trim() ? trimmed : undefined

		if (nextTitle !== item.title) {
			vscode.postMessage({ type: "renameTaskWithId", taskId: item.id, text: nextTitle ?? "" })
		}

		onDone()
	}, [value, item, onDone])

	// Let keydown keep bubbling: VS Code's webview host listens on `window` to run
	// clipboard and undo shortcuts, so stopping propagation breaks paste (Cmd/Ctrl+V).
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key === "Enter") {
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
		<Input
			data-testid="task-title-input"
			aria-label={t("history:renameTask")}
			placeholder={item.task}
			value={value}
			autoFocus
			onFocus={(e) => e.currentTarget.select()}
			onChange={(e) => setValue(e.target.value)}
			onKeyDown={handleKeyDown}
			onBlur={onDone}
			onClick={(e) => e.stopPropagation()}
			className={cn("flex-1 min-w-0 text-base rounded-md select-text", className)}
		/>
	)
}
