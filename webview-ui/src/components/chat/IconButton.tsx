import { cn } from "@src/lib/utils"
import { Button, StandardTooltip } from "@src/components/ui"
import { disabledChatControlClassName, enabledChatControlClassName } from "./chatControlStyles"

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	iconClass: string
	title: string
	disabled?: boolean
	tooltip?: boolean
	isLoading?: boolean
	style?: React.CSSProperties
}

export const IconButton: React.FC<IconButtonProps> = ({
	iconClass,
	title,
	className,
	disabled,
	tooltip = true,
	isLoading,
	onClick,
	style,
	...props
}) => (
	<StandardTooltip content={tooltip ? title : undefined}>
		<Button
			aria-label={title}
			className={cn(
				"relative inline-flex items-center justify-center",
				"bg-transparent border-none p-1.5",
				"rounded-md min-w-[28px] min-h-[28px]",
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
			<span className={cn("codicon", iconClass, isLoading && "codicon-modifier-spin")} />
		</Button>
	</StandardTooltip>
)
