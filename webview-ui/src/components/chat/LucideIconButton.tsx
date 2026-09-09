import { forwardRef } from "react"
import { cn } from "@src/lib/utils"
import { Button, StandardTooltip } from "@src/components/ui"
import { Loader2, LucideIcon } from "lucide-react"
import { disabledChatControlClassName, enabledChatControlClassName } from "./chatControlStyles"

interface LucideIconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	icon: LucideIcon
	title: string
	disabled?: boolean
	tooltip?: boolean
	isLoading?: boolean
	style?: React.CSSProperties
}

export const LucideIconButton = forwardRef<HTMLButtonElement, LucideIconButtonProps>(
	({ icon, title, className, disabled, tooltip = true, isLoading, onClick, style, ...props }, ref) => {
		const Icon = icon
		return (
			<StandardTooltip content={tooltip ? title : undefined}>
				<Button
					ref={ref}
					aria-label={title}
					className={cn(
						"relative inline-flex items-center justify-center",
						"bg-transparent border-none p-1.5",
						"rounded-full",
						"text-vscode-foreground opacity-85",
						"transition-all duration-150",
						"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
						!disabled && cn("cursor-pointer", enabledChatControlClassName),
						disabled && disabledChatControlClassName,
						className,
					)}
					disabled={disabled}
					onClick={!disabled ? onClick : undefined}
					style={{ fontSize: 16.5, ...style }}
					{...props}>
					{isLoading ? <Loader2 className="size-2.5 animate-spin" /> : <Icon className="size-2.5" />}
				</Button>
			</StandardTooltip>
		)
	},
)

LucideIconButton.displayName = "LucideIconButton"
