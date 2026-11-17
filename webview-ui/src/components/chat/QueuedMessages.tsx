import { useState } from "react"
import { useAppTranslation } from "@src/i18n/TranslationContext"

import type { MentionSegment, QueuedMessage } from "@roo-code/types"
import { applyEdit, generatedSegments, normalizeSegments } from "@roo/mentionSegments"

import { Button } from "@src/components/ui"

import Thumbnails from "../common/Thumbnails"

import { Mention } from "./Mention"

interface QueuedMessagesProps {
	queue: QueuedMessage[]
	onRemove: (index: number) => void
	onUpdate: (index: number, newText: string, segments: MentionSegment[]) => void
}

type EditState = { isEditing: boolean; value: string; segments: MentionSegment[] }

export const QueuedMessages = ({ queue, onRemove, onUpdate }: QueuedMessagesProps) => {
	const { t } = useAppTranslation()
	const [editingStates, setEditingStates] = useState<Record<string, EditState>>({})

	if (queue.length === 0) {
		return null
	}

	const getEditState = (message: QueuedMessage): EditState =>
		editingStates[message.id] || {
			isEditing: false,
			value: message.text,
			segments: normalizeSegments(message.text, message.segments),
		}

	const setEditState = (message: QueuedMessage, isEditing: boolean, value: string, segments: MentionSegment[]) => {
		setEditingStates((prev) => ({ ...prev, [message.id]: { isEditing, value, segments } }))
	}

	// Tag each input event here. The saved text alone cannot show which parts the user typed.
	const handleChange = (message: QueuedMessage, previous: EditState, e: React.ChangeEvent<HTMLTextAreaElement>) => {
		const value = e.target.value
		const inputType = e.nativeEvent instanceof InputEvent ? e.nativeEvent.inputType : ""
		// Undo and redo bring back older text with unknown origin. The whole text is generated.
		const segments = inputType.startsWith("history")
			? generatedSegments(value)
			: applyEdit(previous.segments, previous.value, value)
		setEditState(message, true, value, segments)
	}

	const handleSaveEdit = (index: number, message: QueuedMessage, state: EditState) => {
		onUpdate(index, state.value, state.segments)
		setEditState(message, false, state.value, state.segments)
	}

	return (
		<div className="px-[15px] py-[10px] pr-[6px]" data-testid="queued-messages">
			<div className="text-vscode-descriptionForeground text-md mb-2">{t("chat:queuedMessages.title")}</div>
			<div className="flex flex-col gap-2 max-h-[300px] overflow-y-auto pr-2">
				{queue.map((message, index) => {
					const editState = getEditState(message)

					return (
						<div
							key={message.id}
							className="bg-vscode-editor-background border rounded-xs p-1 overflow-hidden whitespace-pre-wrap flex-shrink-0">
							<div className="flex justify-between">
								<div className="flex-grow px-2 py-1 wrap-anywhere">
									{editState.isEditing ? (
										<textarea
											ref={(textarea) => {
												if (textarea) {
													// Set cursor at the end
													textarea.setSelectionRange(
														textarea.value.length,
														textarea.value.length,
													)
												}
											}}
											value={editState.value}
											onChange={(e) => handleChange(message, editState, e)}
											onBlur={() => handleSaveEdit(index, message, editState)}
											onKeyDown={(e) => {
												if (e.key === "Enter" && !e.shiftKey) {
													e.preventDefault()
													handleSaveEdit(index, message, editState)
												}
												if (e.key === "Escape") {
													setEditState(
														message,
														false,
														message.text,
														normalizeSegments(message.text, message.segments),
													)
												}
											}}
											className="w-full bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border rounded px-2 py-1 resize-none focus:outline-0 focus:ring-1 focus:ring-vscode-focusBorder"
											placeholder={t("chat:editMessage.placeholder")}
											autoFocus
											rows={Math.min(editState.value.split("\n").length, 10)}
										/>
									) : (
										<div
											onClick={() =>
												setEditState(
													message,
													true,
													message.text,
													normalizeSegments(message.text, message.segments),
												)
											}
											className="cursor-pointer hover:bg-vscode-list-hoverBackground px-1 py-0.5 -mx-1 -my-0.5 rounded transition-colors"
											title={t("chat:queuedMessages.clickToEdit")}>
											<Mention text={message.text} withShadow />
										</div>
									)}
								</div>
								<div className="flex">
									<Button
										variant="ghost"
										size="icon"
										className="shrink-0"
										onClick={(e) => {
											e.stopPropagation()
											onRemove(index)
										}}>
										<span className="codicon codicon-trash" />
									</Button>
								</div>
							</div>
							{message.images && message.images.length > 0 && (
								<Thumbnails images={message.images} style={{ marginTop: "8px" }} />
							)}
						</div>
					)
				})}
			</div>
		</div>
	)
}
