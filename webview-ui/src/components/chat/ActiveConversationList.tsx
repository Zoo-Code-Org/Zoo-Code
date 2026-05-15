import { useEffect, useMemo, useState } from "react"
import type { ActiveConversationSummary } from "@roo-code/types"
import { Trash2 } from "lucide-react"

import { Button, StandardTooltip } from "@src/components/ui"
import { cn } from "@src/lib/utils"

export interface ConversationListItem extends ActiveConversationSummary {
	kind: "task" | "draft"
}

interface ActiveConversationListProps {
	conversations: ConversationListItem[]
	selectedConversationId?: string
	onCreateConversation: () => void
	onSelectConversation: (conversation: ConversationListItem) => void
	onDeleteConversation: (conversation: ConversationListItem) => void
}

const STATUS_LABELS: Record<ActiveConversationSummary["status"], string> = {
	running: "Running",
	interactive: "Waiting",
	resumable: "Paused",
	idle: "Idle",
	none: "Ready",
}

export default function ActiveConversationList({
	conversations,
	selectedConversationId,
	onCreateConversation,
	onSelectConversation,
	onDeleteConversation,
}: ActiveConversationListProps) {
	const [contextMenu, setContextMenu] = useState<{
		conversation: ConversationListItem
		x: number
		y: number
	} | null>(null)

	useEffect(() => {
		if (!contextMenu) {
			return
		}

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setContextMenu(null)
			}
		}

		window.addEventListener("keydown", handleKeyDown)
		return () => window.removeEventListener("keydown", handleKeyDown)
	}, [contextMenu])

	const contextMenuPosition = useMemo(() => {
		if (!contextMenu) {
			return undefined
		}

		const width = 176
		const height = 52
		const maxLeft = typeof window !== "undefined" ? Math.max(8, window.innerWidth - width - 8) : contextMenu.x
		const maxTop = typeof window !== "undefined" ? Math.max(8, window.innerHeight - height - 8) : contextMenu.y

		return {
			left: Math.min(contextMenu.x, maxLeft),
			top: Math.min(contextMenu.y, maxTop),
		}
	}, [contextMenu])

	if (conversations.length === 0) {
		return null
	}

	return (
		<aside className="flex w-[220px] shrink-0 flex-col border-r border-vscode-editorGroup-border bg-vscode-sideBar-background/40">
			<div className="flex items-center justify-between gap-2 border-b border-vscode-editorGroup-border px-3 py-2">
				<div className="min-w-0">
					<div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-vscode-descriptionForeground">
						Conversations
					</div>
					<div className="text-xs text-vscode-descriptionForeground">{conversations.length} open</div>
				</div>
				<Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onCreateConversation}>
					New
				</Button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto p-2">
				<div className="flex flex-col gap-1">
					{conversations.map((conversation) => {
						const isActive = conversation.activeTaskId === selectedConversationId
						const subtitle =
							conversation.activeTaskId !== conversation.rootTaskId
								? `${conversation.activeTask} · ${STATUS_LABELS[conversation.status]}`
								: STATUS_LABELS[conversation.status]

						return (
							<div
								key={conversation.activeTaskId}
								role="button"
								tabIndex={0}
								aria-pressed={isActive}
								onClick={() => {
									setContextMenu(null)
									onSelectConversation(conversation)
								}}
								onKeyDown={(event) => {
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault()
										setContextMenu(null)
										onSelectConversation(conversation)
									}
								}}
								onContextMenu={(event) => {
									event.preventDefault()
									event.stopPropagation()
									setContextMenu({
										conversation,
										x: event.clientX,
										y: event.clientY,
									})
								}}
								className={cn(
									"group flex w-full cursor-pointer flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors",
									"border-transparent bg-transparent hover:border-vscode-focusBorder/40 hover:bg-vscode-list-hoverBackground focus:outline-none",
									isActive &&
										"border-vscode-focusBorder bg-vscode-list-activeSelectionBackground text-vscode-list-activeSelectionForeground",
								)}>
								<div className="flex items-start justify-between gap-2">
									<div className="min-w-0 text-sm font-medium leading-5">
										<div className="truncate">{conversation.rootTask}</div>
									</div>
									<div className="flex shrink-0 items-center gap-1">
										{conversation.steerMessageCount > 0 && (
											<span
												className={cn(
													"shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold",
													isActive
														? "border-vscode-focusBorder/70 bg-vscode-badge-background text-vscode-badge-foreground"
														: "border-vscode-focusBorder/40 bg-vscode-badge-background/70 text-vscode-badge-foreground",
												)}>
												Steer
											</span>
										)}
										{conversation.queuedMessageCount > 0 && (
											<span
												className={cn(
													"shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
													isActive
														? "bg-vscode-badge-background text-vscode-badge-foreground"
														: "bg-vscode-badge-background/80 text-vscode-badge-foreground",
												)}>
												{conversation.queuedMessageCount}
											</span>
										)}
									</div>
								</div>
								<div className="flex items-center justify-between gap-2">
									<div
										className={cn(
											"min-w-0 text-xs leading-4",
											isActive ? "opacity-80" : "text-vscode-descriptionForeground",
										)}>
										<div className="truncate">{subtitle}</div>
									</div>
									<StandardTooltip content="Delete">
										<Button
											variant="ghost"
											size="icon"
											aria-label="Delete conversation"
											className={cn(
												"h-6 w-6 shrink-0 rounded-md opacity-0 transition-opacity group-hover:opacity-100",
												isActive && "opacity-70 group-hover:opacity-100",
											)}
											onClick={(event) => {
												event.stopPropagation()
												setContextMenu(null)
												onDeleteConversation(conversation)
											}}>
											<Trash2 className="size-3.5" />
										</Button>
									</StandardTooltip>
								</div>
							</div>
						)
					})}
				</div>
			</div>
			{contextMenu && contextMenuPosition && (
				<div
					className="fixed inset-0 z-50"
					onMouseDown={() => setContextMenu(null)}
					onContextMenu={(event) => event.preventDefault()}>
					<div
						data-conversation-context-menu
						className="absolute min-w-44 overflow-hidden rounded-md border border-vscode-focusBorder bg-vscode-dropdown-background p-1 text-vscode-dropdown-foreground shadow-lg"
						style={contextMenuPosition}
						onMouseDown={(event) => event.stopPropagation()}
						onClick={(event) => event.stopPropagation()}>
						<button
							type="button"
							className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-vscode-list-activeSelectionBackground hover:text-vscode-list-activeSelectionForeground"
							onClick={() => {
								onDeleteConversation(contextMenu.conversation)
								setContextMenu(null)
							}}>
							<Trash2 className="size-4" />
							Delete
						</button>
					</div>
				</div>
			)}
		</aside>
	)
}
