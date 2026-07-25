import React, { useCallback, useState } from "react"
import { Pin } from "lucide-react"

import { Button } from "@/components/ui/button"
import { StandardTooltip } from "@/components/ui/standard-tooltip"
import { useAppTranslation } from "@/i18n/TranslationContext"

export interface PinButtonProps {
	/** Whether the target is currently pinned. */
	isPinned: boolean
	/** Whether pinning is currently allowed (i.e. under the global limit). */
	canPin: boolean
	/** Callback when the button is toggled. */
	onToggle: () => void
	/** Optional size variant. */
	size?: "sm" | "default"
	/** Optional className. */
	className?: string
	/** Data attribute for tests. */
	"data-testid"?: string
}

/**
 * Pin toggle button for tasks, automatic groups, and manual folders.
 *
 * The button shows immediate visual feedback. It does not own the pin state;
 * the parent controls `isPinned` and `onToggle`.
 */
export const PinButton: React.FC<PinButtonProps> = ({
	isPinned,
	canPin,
	onToggle,
	size = "default",
	className,
	"data-testid": dataTestId,
}) => {
	const { t } = useAppTranslation()
	const [showLimitError, setShowLimitError] = useState(false)

	const handleClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation()
			if (!isPinned && !canPin) {
				setShowLimitError(true)
				window.setTimeout(() => setShowLimitError(false), 1500)
				return
			}
			onToggle()
		},
		[isPinned, canPin, onToggle],
	)

	const label = isPinned ? t("history:unpin") : t("history:pin")
	const isDisabled = !isPinned && !canPin

	return (
		<StandardTooltip content={isDisabled ? t("history:pinLimitReached") : label}>
			<Button
				variant="ghost"
				size={size === "sm" ? "sm" : "icon"}
				className={className}
				onClick={handleClick}
				aria-label={label}
				aria-pressed={isPinned}
				data-testid={dataTestId ?? "pin-button"}
				data-pinned={isPinned ? "true" : "false"}
				data-limit-error={showLimitError ? "true" : "false"}>
				<Pin
					className={[
						"size-4 shrink-0 transition-transform",
						isPinned ? "fill-current" : "",
						showLimitError ? "text-vscode-errorForeground" : "",
					]
						.filter(Boolean)
						.join(" ")}
				/>
			</Button>
		</StandardTooltip>
	)
}
