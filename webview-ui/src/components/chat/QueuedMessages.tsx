import { useLayoutEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { QueuedMessage } from "@roo-code/types"

import { Button } from "@src/components/ui"

import Thumbnails from "../common/Thumbnails"

import { Mention } from "./Mention"

interface QueuedMessagesProps {
	queue: QueuedMessage[]
	onRemove: (messageId: string) => void
	onUpdate: (message: QueuedMessage, updates: { text?: string; deliveryMode?: QueuedMessage["deliveryMode"] }) => void
}

interface QueuedMessageEditorProps {
	value: string
	onChange: (value: string) => void
	onSave: () => void
	onCancel: () => void
	placeholder: string
	rows: number
}

const QueuedMessageEditor = ({ value, onChange, onSave, onCancel, placeholder, rows }: QueuedMessageEditorProps) => {
	const textareaRef = useRef<HTMLTextAreaElement | null>(null)
	const didPlaceInitialCaretRef = useRef(false)

	useLayoutEffect(() => {
		if (didPlaceInitialCaretRef.current || !textareaRef.current) {
			return
		}

		didPlaceInitialCaretRef.current = true
		const textarea = textareaRef.current
		textarea.focus()
		textarea.setSelectionRange(textarea.value.length, textarea.value.length)
	}, [])

	return (
		<textarea
			ref={textareaRef}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			onBlur={onSave}
			onKeyDown={(e) => {
				if (e.key === "Enter" && !e.shiftKey) {
					e.preventDefault()
					onSave()
				}
				if (e.key === "Escape") {
					onCancel()
				}
			}}
			className="w-full bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border rounded px-2 py-1 resize-none focus:outline-0 focus:ring-1 focus:ring-vscode-focusBorder"
			placeholder={placeholder}
			rows={rows}
		/>
	)
}

export const QueuedMessages = ({ queue, onRemove, onUpdate }: QueuedMessagesProps) => {
	const { t } = useTranslation("chat")
	const [editingStates, setEditingStates] = useState<Record<string, { isEditing: boolean; value: string }>>({})

	if (queue.length === 0) {
		return null
	}

	const getEditState = (messageId: string, currentText: string) => {
		return editingStates[messageId] || { isEditing: false, value: currentText }
	}

	const setEditState = (messageId: string, isEditing: boolean, value?: string) => {
		setEditingStates((prev) => ({
			...prev,
			[messageId]: { isEditing, value: value ?? prev[messageId]?.value ?? "" },
		}))
	}

	const handleSaveEdit = (message: QueuedMessage, newValue: string) => {
		onUpdate(message, { text: newValue })
		setEditState(message.id, false)
	}

	const handleCancelEdit = (message: QueuedMessage) => {
		setEditState(message.id, false, message.text)
	}

	const renderLane = (
		title: string,
		messages: QueuedMessage[],
		options?: { emptyLabel?: string; alternateActionLabel?: string; alternateMode?: QueuedMessage["deliveryMode"] },
	) => {
		if (messages.length === 0 && !options?.emptyLabel) {
			return null
		}

		return (
			<div className="flex flex-col gap-2">
				<div className="flex items-center justify-between gap-2 px-1">
					<div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-vscode-descriptionForeground">
						{title}
					</div>
					<div className="text-[11px] text-vscode-descriptionForeground">{messages.length}</div>
				</div>
				{messages.length === 0 ? (
					<div className="rounded-xs border border-dashed border-vscode-editorGroup-border px-3 py-2 text-xs text-vscode-descriptionForeground">
						{options?.emptyLabel}
					</div>
				) : (
					messages.map((message) => {
						const editState = getEditState(message.id, message.text)

						return (
							<div
								key={message.id}
								className="bg-vscode-editor-background border rounded-xs p-1 overflow-hidden whitespace-pre-wrap flex-shrink-0">
								<div className="flex justify-between gap-2">
									<div className="flex-grow px-2 py-1 wrap-anywhere">
										<div className="mb-1 flex items-center gap-2">
											<span className="rounded-full bg-vscode-badge-background/80 px-1.5 py-0.5 text-[10px] font-semibold text-vscode-badge-foreground">
												{message.deliveryMode === "steer" ? "Steer next" : "Queued"}
											</span>
										</div>
										{editState.isEditing ? (
											<QueuedMessageEditor
												value={editState.value}
												onChange={(value) => setEditState(message.id, true, value)}
												onSave={() => handleSaveEdit(message, editState.value)}
												onCancel={() => handleCancelEdit(message)}
												placeholder={t("chat:editMessage.placeholder")}
												rows={Math.min(editState.value.split("\n").length, 10)}
											/>
										) : (
											<div
												onClick={() => setEditState(message.id, true, message.text)}
												className="cursor-pointer hover:bg-vscode-list-hoverBackground px-1 py-0.5 -mx-1 -my-0.5 rounded transition-colors"
												title={t("chat:queuedMessages.clickToEdit")}>
												<Mention text={message.text} withShadow />
											</div>
										)}
									</div>
									<div className="flex shrink-0 flex-col items-end gap-1 py-1 pr-1">
										{options?.alternateMode && options.alternateActionLabel && (
											<Button
												variant="ghost"
												size="sm"
												className="h-6 rounded-md px-2 text-xs"
												onClick={(e) => {
													e.stopPropagation()
													onUpdate(message, { deliveryMode: options.alternateMode })
												}}>
												{options.alternateActionLabel}
											</Button>
										)}
										<Button
											variant="ghost"
											size="icon"
											className="shrink-0"
											onClick={(e) => {
												e.stopPropagation()
												onRemove(message.id)
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
					})
				)}
			</div>
		)
	}

	const steerMessages = queue.filter((message) => message.deliveryMode === "steer")
	const queuedMessages = queue.filter((message) => message.deliveryMode !== "steer")

	return (
		<div className="px-[15px] py-[10px] pr-[6px]" data-testid="queued-messages">
			<div className="text-vscode-descriptionForeground text-md mb-2">{t("queuedMessages.title")}</div>
			<div className="flex flex-col gap-3 max-h-[320px] overflow-y-auto pr-2">
				{renderLane("Steer next", steerMessages, {
					emptyLabel: "No steer messages pending.",
					alternateActionLabel: "Queue",
					alternateMode: "queue",
				})}
				{renderLane("Queued", queuedMessages, {
					alternateActionLabel: "Steer",
					alternateMode: "steer",
				})}
			</div>
		</div>
	)
}
