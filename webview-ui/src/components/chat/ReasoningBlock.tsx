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
	const [elapsed, setElapsed] = useState<number>(() => (isStreaming ? 0 : Math.max(0, Date.now() - ts)))
	const contentRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		setIsCollapsed(reasoningBlockCollapsed)
	}, [reasoningBlockCollapsed])

	useEffect(() => {
		if (isLast && isStreaming) {
			const tick = () => setElapsed(Date.now() - startTimeRef.current)
			tick()
			const id = setInterval(tick, 1000)
			return () => clearInterval(id)
		}
	}, [isLast, isStreaming])

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
