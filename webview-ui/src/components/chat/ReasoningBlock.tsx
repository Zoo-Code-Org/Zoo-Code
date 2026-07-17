import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useExtensionState } from "@src/context/ExtensionStateContext"

import MarkdownBlock from "../common/MarkdownBlock"
import { Lightbulb, ChevronUp } from "lucide-react"
import { cn } from "@/lib/utils"

interface ReasoningBlockProps {
	content: string
	ts: number
	isStreaming: boolean
	isLast: boolean
	metadata?: any
}

/**
 * Module-level cache that persists elapsed reasoning durations across
 * React component remounts. When Virtuoso recycles a ReasoningBlock
 * (e.g., during expand/collapse or scroll), the cache provides the
 * final elapsed value from the previous mount cycle instead of
 * recomputing from Date.now() - ts, which would be wrong if minutes
 * have passed since the message was created.
 */
const elapsedCache = new Map<number, number>()

export const ReasoningBlock = ({ content, isStreaming, isLast, ts }: ReasoningBlockProps) => {
	const { t } = useTranslation()
	const { reasoningBlockCollapsed } = useExtensionState()

	const [isCollapsed, setIsCollapsed] = useState(reasoningBlockCollapsed)

	// Anchor the elapsed timer to the message creation timestamp (ts)
	// rather than component mount time. When Virtuoso recycles or
	// remounts this component (e.g. during expand/collapse in a
	// virtualized list), the timer survives because ts is a stable
	// prop from the message data rather than a fresh Date.now().
	const startTimeRef = useRef<number>(ts)
	// On init, prefer cached elapsed (survives remounts). If not cached,
	// use Date.now() - ts for a reasonable initial estimate. This handles
	// the first mount where no cached value exists yet.
	const [elapsed, setElapsed] = useState<number>(() => {
		const cached = elapsedCache.get(ts)
		if (cached !== undefined) return cached
		return isStreaming ? 0 : Math.max(0, Date.now() - ts)
	})
	const contentRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		setIsCollapsed(reasoningBlockCollapsed)
	}, [reasoningBlockCollapsed])

	useEffect(() => {
		if (isLast && isStreaming) {
			const tick = () => {
				const current = Date.now() - startTimeRef.current
				setElapsed(current)
				elapsedCache.set(ts, current)
			}
			tick()
			const id = setInterval(tick, 1000)
			return () => clearInterval(id)
		}
	}, [isLast, isStreaming])

	// Cache the final elapsed value when streaming stops so it survives
	// future remounts even if the component unmounts before the timer
	// effect cleanup runs.
	useEffect(() => {
		if (!isStreaming && elapsed > 0) {
			elapsedCache.set(ts, elapsed)
		}
	}, [isStreaming, ts, elapsed])

	const seconds = Math.floor(elapsed / 1000)
	const secondsLabel = t("chat:reasoning.seconds", { count: seconds })

	const handleToggle = () => {
		setIsCollapsed(!isCollapsed)
	}

	return (
		<div className="group">
			<div
				className="flex items-center justify-between mb-2.5 pr-2 cursor-pointer select-none"
				onClick={handleToggle}>
				<div className="flex items-center gap-2">
					<Lightbulb className="w-4" />
					<span className="font-bold text-vscode-foreground">{t("chat:reasoning.thinking")}</span>
					{elapsed > 0 && (
						<span className="text-sm text-vscode-descriptionForeground mt-0.5">{secondsLabel}</span>
					)}
				</div>
				<div className="flex items-center gap-2">
					<ChevronUp
						className={cn(
							"w-4 transition-all opacity-0 group-hover:opacity-100",
							isCollapsed && "-rotate-180",
						)}
					/>
				</div>
			</div>
			{(content?.trim()?.length ?? 0) > 0 && !isCollapsed && (
				<div
					ref={contentRef}
					className="border-l border-vscode-descriptionForeground/20 ml-2 pl-4 pb-1 text-vscode-descriptionForeground break-words">
					<MarkdownBlock markdown={content} />
				</div>
			)}
		</div>
	)
}
