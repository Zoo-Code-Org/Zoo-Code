import { Clock } from "lucide-react"

import { cn } from "@src/lib/utils"
import { formatDateTime, formatMessageTime, type DateFormat, type TimeFormat } from "@/utils/format"

import { StandardTooltip } from "../ui/standard-tooltip"

interface MessageTimestampProps {
	/** Epoch ms the message was sent. */
	ts: number
	/** From the user's Language settings; both default to "auto". */
	timeFormat?: TimeFormat
	dateFormat?: DateFormat
	className?: string
}

/**
 * Whether `ts` is a time that can be shown. Number.isFinite is not enough: a finite value beyond ±8.64e15 ms is an
 * Invalid Date, and toISOString() would throw during render and take the whole chat row down with it. Callers that
 * wrap the timestamp in spacing use this, so an invalid time leaves no empty block behind.
 */
export const isShowableTimestamp = (ts: number) =>
	Number.isFinite(ts) && ts > 0 && !Number.isNaN(new Date(ts).getTime())

/**
 * "🕒 Yesterday 11:43 AM" under a sent message.
 *
 * Purely presentational: the caller supplies the user's time/date formats, so
 * the component has no dependency on extension state and renders anywhere. The
 * tooltip always carries the full date and time. A semantic <time> element
 * gives assistive tech and copy/paste the exact value.
 */
export const MessageTimestamp = ({ ts, timeFormat, dateFormat, className }: MessageTimestampProps) => {
	if (!isShowableTimestamp(ts)) return null
	const date = new Date(ts)

	return (
		<StandardTooltip content={formatDateTime(ts, timeFormat, dateFormat)}>
			<time
				dateTime={date.toISOString()}
				className={cn(
					"inline-flex items-center gap-1.5 text-xs text-vscode-descriptionForeground select-none",
					className,
				)}
				data-testid="message-timestamp">
				<Clock className="size-3.5 shrink-0" aria-hidden="true" />
				{formatMessageTime(ts, { timeFormat, dateFormat })}
			</time>
		</StandardTooltip>
	)
}
