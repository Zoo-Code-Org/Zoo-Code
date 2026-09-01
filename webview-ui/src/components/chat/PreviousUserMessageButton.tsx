import { Button, StandardTooltip } from "@src/components/ui"

interface PreviousUserMessageButtonProps {
	title: string
	className?: string
	onClick: () => void
}

export const PreviousUserMessageButton = ({ title, className, onClick }: PreviousUserMessageButtonProps) => (
	<StandardTooltip content={title}>
		<Button variant="secondary" className={className} onClick={onClick} aria-label={title}>
			<span className="flex items-center gap-0.5">
				<span className="codicon codicon-account" />
				<span className="codicon codicon-arrow-up text-[10px] -ml-0.5" />
			</span>
		</Button>
	</StandardTooltip>
)
