import { useState, useRef, useEffect } from "react"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { getZooCodeAuthUrl } from "@src/oauth/urls"
import { vscode } from "@src/utils/vscode"
import { cn } from "@src/lib/utils"

interface ZooCodeAuthBadgeProps {
	className?: string
}

// Generate a deterministic color from email/name
function getAvatarColor(str: string): string {
	const colors = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#8b5cf6", "#ec4899", "#6366f1"]
	let hash = 0
	for (let i = 0; i < str.length; i++) {
		hash = str.charCodeAt(i) + ((hash << 5) - hash)
	}
	return colors[Math.abs(hash) % colors.length]
}

// Get proper initials from name or email
function getInitials(name?: string, email?: string): string {
	if (name) {
		const parts = name.trim().split(" ")
		if (parts.length >= 2) {
			return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
		}
		return name.slice(0, 2).toUpperCase()
	}
	if (email) {
		return email.slice(0, 2).toUpperCase()
	}
	return "?"
}

export const ZooCodeAuthBadge: React.FC<ZooCodeAuthBadgeProps> = ({ className }) => {
	const { zooCodeIsAuthenticated, zooCodeUserName, zooCodeUserEmail, zooCodeUserImage, zooCodeBaseUrl, uriScheme } =
		useExtensionState()
	const [isOpen, setIsOpen] = useState(false)
	const [imageError, setImageError] = useState(false)
	const ref = useRef<HTMLDivElement>(null)

	// Close on outside click
	useEffect(() => {
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setIsOpen(false)
			}
		}
		document.addEventListener("mousedown", handler)
		return () => document.removeEventListener("mousedown", handler)
	}, [])

	// Reset image error when image URL changes
	useEffect(() => {
		setImageError(false)
	}, [zooCodeUserImage])

	const authUrl = getZooCodeAuthUrl(uriScheme, zooCodeBaseUrl)

	const showImage = zooCodeIsAuthenticated && zooCodeUserImage && !imageError
	const avatarColor = getAvatarColor(zooCodeUserEmail || zooCodeUserName || "ZC")

	const handleSignOut = () => {
		vscode.postMessage({ type: "zooCodeSignOut" })
		setIsOpen(false)
	}

	return (
		<div ref={ref} className={cn("relative ml-2", className)}>
			{/* The icon button */}
			<button
				onClick={() => setIsOpen(!isOpen)}
				className={cn(
					"flex items-center justify-center",
					"w-5 h-5 rounded-full",
					"cursor-pointer p-0",
					"transition-all duration-150",
					"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
					"overflow-hidden",
					!zooCodeIsAuthenticated &&
						"bg-transparent text-vscode-descriptionForeground border border-vscode-descriptionForeground border-opacity-50 hover:border-opacity-100",
				)}
				style={{
					fontSize: zooCodeIsAuthenticated && !showImage ? 9 : 14,
					fontWeight: 600,
					background: zooCodeIsAuthenticated ? (showImage ? "transparent" : avatarColor) : undefined,
					color:
						zooCodeIsAuthenticated && !showImage ? "var(--vscode-button-foreground, #ffffff)" : undefined,
				}}
				title={zooCodeIsAuthenticated ? `Zoo Code: ${zooCodeUserEmail || "Connected"}` : "Sign in to Zoo Code"}>
				{zooCodeIsAuthenticated ? (
					showImage ? (
						<img
							src={zooCodeUserImage}
							alt="avatar"
							style={{
								width: "100%",
								height: "100%",
								borderRadius: "50%",
								objectFit: "cover",
							}}
							onError={() => setImageError(true)}
						/>
					) : (
						<span>{getInitials(zooCodeUserName, zooCodeUserEmail)}</span>
					)
				) : (
					// Person icon SVG
					<svg
						width="10"
						height="10"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.5"
						strokeLinecap="round"
						strokeLinejoin="round">
						<circle cx="12" cy="8" r="4" />
						<path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
					</svg>
				)}
			</button>

			{/* Popover */}
			{isOpen && (
				<div
					className={cn(
						"absolute bottom-[calc(100%+8px)] right-0",
						"rounded-md",
						"shadow-lg",
						"min-w-[180px]",
						"overflow-hidden",
					)}
					style={{
						background: "var(--vscode-menu-background)",
						border: "1px solid var(--vscode-menu-border, var(--vscode-widget-border, #3c3c3c))",
						zIndex: 9999,
					}}>
					{!zooCodeIsAuthenticated ? (
						<a
							href={authUrl}
							onClick={() => setIsOpen(false)}
							className={cn("block px-3.5 py-2.5", "text-[13px]", "no-underline cursor-pointer")}
							style={{
								color: "var(--vscode-menu-foreground)",
							}}
							onMouseEnter={(e) =>
								(e.currentTarget.style.background = "var(--vscode-menu-selectionBackground)")
							}
							onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
							Sign in to Zoo Code
						</a>
					) : (
						<>
							{zooCodeUserEmail && (
								<div
									className={cn(
										"px-3.5 py-2 pb-1.5",
										"text-[11px]",
										"pointer-events-none select-none",
									)}
									style={{
										color: "var(--vscode-descriptionForeground)",
										borderBottom:
											"1px solid var(--vscode-menu-separatorBackground, var(--vscode-widget-border, #3c3c3c))",
									}}>
									{zooCodeUserEmail}
								</div>
							)}
							<a
								href={`${zooCodeBaseUrl || "https://www.zoocode.dev"}/dashboard`}
								onClick={() => setIsOpen(false)}
								className={cn("block px-3.5 py-2.5", "text-[13px]", "no-underline cursor-pointer")}
								style={{
									color: "var(--vscode-menu-foreground)",
								}}
								onMouseEnter={(e) =>
									(e.currentTarget.style.background = "var(--vscode-menu-selectionBackground)")
								}
								onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
								Go to Dashboard
							</a>
							<button
								onClick={handleSignOut}
								className={cn(
									"block w-full px-3.5 py-2.5",
									"text-[13px]",
									"bg-transparent border-none",
									"text-left cursor-pointer",
								)}
								style={{
									color: "var(--vscode-errorForeground)",
								}}
								onMouseEnter={(e) =>
									(e.currentTarget.style.background = "var(--vscode-menu-selectionBackground)")
								}
								onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
								Sign out
							</button>
						</>
					)}
				</div>
			)}
		</div>
	)
}
