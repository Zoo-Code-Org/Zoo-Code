import React, { memo } from "react"

import { Button } from "@/components/ui/button"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { cn } from "@/lib/utils"
import { ChevronDown, ChevronRight, Folder, Pin } from "lucide-react"

import { PinButton } from "./PinButton"
import type { ResolvedTaskUnit } from "./types"

export interface PinnedHistoryItemProps {
	/** The pinned unit, or undefined for a pinned folder. */
	unit?: ResolvedTaskUnit
	/** For pinned folders, the folder display name. */
	folderName?: string
	/** Optional display label for pinned units (defaults to rootTaskId). */
	label?: string
	/** Whether the target is currently pinned (always true for pinned items). */
	isPinned: boolean
	/** Whether pinning is currently allowed. */
	canPin: boolean
	/** Callback when pin is toggled. */
	onTogglePin: () => void
	/** Callback when the item is clicked. */
	onClick?: () => void
	/** Whether a pinned folder card is expanded to show its members. */
	isExpanded?: boolean
	/** Member rows rendered below the header when a pinned folder is expanded. */
	children?: React.ReactNode
	/** Optional className. */
	className?: string
	/** Optional data-testid. */
	"data-testid"?: string
}

/**
 * Compact pinned shortcut for the pinned section of History and Recent Tasks.
 * Renders a folder card for pinned folders or a task card for pinned units.
 * Pinned folders expand in place (like a regular folder) to reveal their
 * member tasks; pinned units open their task on click.
 */
export const PinnedHistoryItem: React.FC<PinnedHistoryItemProps> = ({
	unit,
	folderName,
	label,
	isPinned,
	canPin,
	onTogglePin,
	onClick,
	isExpanded = false,
	children,
	className,
	"data-testid": dataTestId,
}) => {
	const { t } = useAppTranslation()
	const isFolder = unit === undefined

	return (
		<div
			data-testid={dataTestId ?? "pinned-history-item"}
			className={cn(
				"group relative rounded-xl border border-vscode-panel-border",
				"bg-vscode-editor-background hover:bg-vscode-list-hoverBackground transition-colors",
				className,
			)}>
			<div className="flex items-center gap-2 px-3 py-2">
				{isFolder ? (
					<Folder className="size-4 text-vscode-descriptionForeground shrink-0" />
				) : (
					<Pin className="size-4 text-vscode-descriptionForeground shrink-0" />
				)}

				<Button
					variant="ghost"
					className="flex-1 min-w-0 justify-start h-auto px-0 py-0 font-normal text-left truncate"
					onClick={onClick}
					aria-label={isFolder ? t("history:openFolder", { name: folderName }) : t("history:openTask")}>
					<span className="truncate" data-testid="pinned-item-label">
						{isFolder ? folderName : (label ?? unit.rootTaskId)}
					</span>
				</Button>

				{isFolder &&
					(isExpanded ? (
						<ChevronDown className="size-4 text-vscode-descriptionForeground shrink-0" />
					) : (
						<ChevronRight className="size-4 text-vscode-descriptionForeground shrink-0" />
					))}

				<div className="opacity-0 group-hover:opacity-100 transition-opacity">
					<PinButton
						isPinned={isPinned}
						canPin={canPin}
						onToggle={onTogglePin}
						size="sm"
						data-testid="pinned-item-pin-button"
					/>
				</div>
			</div>

			{isFolder && isExpanded && children && (
				<div
					className="flex flex-col gap-1 border-t border-vscode-panel-border px-2 py-2"
					data-testid="pinned-folder-children">
					{children}
				</div>
			)}
		</div>
	)
}

export default memo(PinnedHistoryItem)
