import { useEffect, useState } from "react"

export type MermaidThemeKind = "dark" | "light" | "high-contrast" | "high-contrast-light"

interface MermaidThemeState {
	kind: MermaidThemeKind
	signature: string
}

const DARK_FALLBACK = {
	background: "#1e1e1e",
	foreground: "#d4d4d4",
	surface: "#3c3c3c",
	border: "#888888",
	link: "#3794ff",
}

const LIGHT_FALLBACK = {
	background: "#ffffff",
	foreground: "#333333",
	surface: "#ffffff",
	border: "#717171",
	link: "#006ab1",
}

function parseColor(value: string): [number, number, number, number] | undefined {
	const color = value.trim()
	const hex = color.match(/^#([\da-f]{3,8})$/i)?.[1]

	if (hex) {
		const expanded = hex.length === 3 || hex.length === 4 ? [...hex].map((digit) => digit + digit).join("") : hex
		if (expanded.length === 6 || expanded.length === 8) {
			return [
				parseInt(expanded.slice(0, 2), 16),
				parseInt(expanded.slice(2, 4), 16),
				parseInt(expanded.slice(4, 6), 16),
				expanded.length === 8 ? parseInt(expanded.slice(6, 8), 16) / 255 : 1,
			]
		}
	}

	if (/^rgba?\(/i.test(color)) {
		const channels = color.match(/[\d.]+/g)?.map(Number)
		if (channels && channels.length >= 3) {
			return [channels[0], channels[1], channels[2], channels[3] ?? 1]
		}
	}

	return undefined
}

function toHex(value: string, fallback: string, background = fallback): string {
	const fallbackColor = parseColor(fallback) ?? [0, 0, 0, 1]
	const backgroundColor = parseColor(background) ?? fallbackColor
	const [red, green, blue, alpha] = parseColor(value) ?? fallbackColor
	const channels = [red, green, blue].map((channel, index) =>
		Math.round(channel * alpha + backgroundColor[index] * (1 - alpha)),
	)

	return `#${channels.map((channel) => Math.max(0, Math.min(255, channel)).toString(16).padStart(2, "0")).join("")}`
}

function getThemeKind(): MermaidThemeKind {
	const body = document.body
	const className = body.className
	const themeKind = body.dataset.vscodeThemeKind ?? ""

	if (/vscode-high-contrast-light/i.test(`${className} ${themeKind}`)) return "high-contrast-light"
	if (/vscode-high-contrast/i.test(`${className} ${themeKind}`)) return "high-contrast"
	if (/vscode-light/i.test(className)) return "light"
	return "dark"
}

function getThemeState(): MermaidThemeState {
	const styles = getComputedStyle(document.body)
	const signature = [
		document.body.dataset.vscodeThemeId,
		document.body.dataset.vscodeThemeKind,
		document.body.className,
		styles.getPropertyValue("--vscode-editor-background"),
		styles.getPropertyValue("--vscode-editor-foreground"),
		styles.getPropertyValue("--vscode-input-background"),
		styles.getPropertyValue("--vscode-input-border"),
		styles.getPropertyValue("--vscode-textLink-foreground"),
	].join("|")

	return { kind: getThemeKind(), signature }
}

export function useMermaidTheme(): MermaidThemeState {
	const [theme, setTheme] = useState(getThemeState)

	useEffect(() => {
		const updateTheme = () => {
			const nextTheme = getThemeState()
			setTheme((currentTheme) => (currentTheme.signature === nextTheme.signature ? currentTheme : nextTheme))
		}
		const observer = new MutationObserver(updateTheme)
		const options: MutationObserverInit = {
			attributes: true,
			attributeFilter: ["class", "style", "data-vscode-theme-id", "data-vscode-theme-kind"],
		}

		observer.observe(document.documentElement, options)
		observer.observe(document.body, options)
		return () => observer.disconnect()
	}, [])

	return theme
}

export function getMermaidConfig(kind: MermaidThemeKind) {
	const isDark = kind === "dark" || kind === "high-contrast"
	const fallback = isDark ? DARK_FALLBACK : LIGHT_FALLBACK
	const styles = getComputedStyle(document.body)
	const background = toHex(styles.getPropertyValue("--vscode-editor-background"), fallback.background)
	const foreground = toHex(styles.getPropertyValue("--vscode-editor-foreground"), fallback.foreground, background)
	const surface = toHex(styles.getPropertyValue("--vscode-input-background"), fallback.surface, background)
	const border = toHex(styles.getPropertyValue("--vscode-input-border"), fallback.border, background)
	const link = toHex(styles.getPropertyValue("--vscode-textLink-foreground"), fallback.link, background)

	return {
		startOnLoad: false,
		securityLevel: "strict" as const,
		theme: "base" as const,
		suppressErrorRendering: true,
		themeVariables: {
			darkMode: isDark,
			background,
			primaryColor: surface,
			primaryTextColor: foreground,
			primaryBorderColor: border,
			secondaryColor: background,
			secondaryTextColor: foreground,
			secondaryBorderColor: border,
			tertiaryColor: surface,
			tertiaryTextColor: foreground,
			tertiaryBorderColor: border,
			lineColor: foreground,
			textColor: foreground,
			noteBkgColor: surface,
			noteTextColor: foreground,
			noteBorderColor: border,
			linkColor: link,
			fontSize: "16px",
			fontFamily: "var(--vscode-font-family, 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif)",
		},
	}
}

export function getMermaidBackgroundColor(): string {
	return getMermaidConfig(getThemeKind()).themeVariables.background
}
