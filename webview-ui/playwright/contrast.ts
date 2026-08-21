import type { Locator } from "@playwright/test"
import { expect } from "@playwright/test"

export interface RgbaColor {
	r: number
	g: number
	b: number
	a: number
}

export type ContrastProperty = "color" | "background-color" | "border-color" | "outline-color" | "fill" | "stroke"

interface ContrastOptions {
	background?: Locator
	foregroundProperty?: ContrastProperty
	backgroundProperty?: ContrastProperty
	minimum?: number | "text"
	label: string
}

interface ContrastStyles {
	foreground: string
	foregroundOpacity: number
	backgroundLayers: Array<{ color: string; opacity: number }>
	fontSize: number
	fontWeight: number
}

export function parseCssColor(value: string): RgbaColor {
	const match = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i)
	if (match) {
		const alpha = match[4]?.endsWith("%") ? Number.parseFloat(match[4]) / 100 : Number.parseFloat(match[4] ?? "1")
		return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: alpha }
	}

	const oklab = value.match(/^oklab\(\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/i)
	if (!oklab) throw new Error(`Unsupported CSS color: ${value}`)
	const [lightness, axisA, axisB] = oklab.slice(1, 4).map(Number)
	const l = (lightness + 0.3963377774 * axisA + 0.2158037573 * axisB) ** 3
	const m = (lightness - 0.1055613458 * axisA - 0.0638541728 * axisB) ** 3
	const s = (lightness - 0.0894841775 * axisA - 1.291485548 * axisB) ** 3
	const linear = [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	]
	const [r, g, b] = linear.map((channel) => {
		const value = channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055
		return Math.min(255, Math.max(0, value * 255))
	})
	const alpha = oklab[4]?.endsWith("%") ? Number.parseFloat(oklab[4]) / 100 : Number.parseFloat(oklab[4] ?? "1")
	return { r, g, b, a: alpha }
}

export function composite(foreground: RgbaColor, background: RgbaColor): RgbaColor {
	const alpha = foreground.a + background.a * (1 - foreground.a)
	if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 }
	return {
		r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
		g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
		b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
		a: alpha,
	}
}

export function contrastRatio(first: RgbaColor, second: RgbaColor): number {
	const luminance = ({ r, g, b }: RgbaColor) => {
		const channels = [r, g, b].map((channel) => {
			const value = channel / 255
			return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
		})
		return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
	}
	const lighter = Math.max(luminance(first), luminance(second))
	const darker = Math.min(luminance(first), luminance(second))
	return (lighter + 0.05) / (darker + 0.05)
}

export function requiredTextContrast(fontSize: number, fontWeight: number): number {
	return fontSize >= 24 || (fontSize >= 56 / 3 && fontWeight >= 700) ? 3 : 4.5
}

export async function expectContrast(foreground: Locator, options: ContrastOptions) {
	const backgroundToken = options.background ? `contrast-${Date.now()}-${Math.random()}` : null
	if (options.background && backgroundToken) {
		await options.background.evaluate(
			(element, token) => element.setAttribute("data-contrast-background", token),
			backgroundToken,
		)
	}
	let styles: ContrastStyles
	try {
		styles = await foreground.evaluate(
			(element, { backgroundToken, foregroundProperty, backgroundProperty }): ContrastStyles => {
				const assertSupported = (current: Element, styles: CSSStyleDeclaration, allowLeafOpacity: boolean) => {
					if (styles.backgroundImage !== "none")
						throw new Error(`Unsupported background image on ${current.tagName.toLowerCase()}`)
					if (styles.filter !== "none")
						throw new Error(`Unsupported filter on ${current.tagName.toLowerCase()}`)
					if (styles.backdropFilter !== "none")
						throw new Error(`Unsupported backdrop filter on ${current.tagName.toLowerCase()}`)
					if (styles.mixBlendMode !== "normal" || styles.backgroundBlendMode !== "normal") {
						throw new Error(`Unsupported blend mode on ${current.tagName.toLowerCase()}`)
					}
					if (styles.maskImage !== "none")
						throw new Error(`Unsupported mask on ${current.tagName.toLowerCase()}`)
					if (!allowLeafOpacity && Number(styles.opacity) !== 1) {
						throw new Error(`Unsupported group opacity on ${current.tagName.toLowerCase()}`)
					}
				}
				const styleValue = (styles: CSSStyleDeclaration, property: ContrastProperty) => {
					if (property === "fill" || property === "stroke") return styles[property]
					return styles.getPropertyValue(property)
				}
				const foregroundStyles = getComputedStyle(element)
				assertSupported(
					element,
					foregroundStyles,
					foregroundStyles.backgroundColor.endsWith(", 0)") ||
						foregroundStyles.backgroundColor.endsWith("/ 0)"),
				)
				let foregroundAncestor = element.parentElement
				while (foregroundAncestor) {
					assertSupported(foregroundAncestor, getComputedStyle(foregroundAncestor), false)
					foregroundAncestor = foregroundAncestor.parentElement
				}
				const backgroundLayers: Array<{ color: string; opacity: number }> = []
				let current: Element | null = backgroundToken
					? document.querySelector(`[data-contrast-background="${CSS.escape(backgroundToken)}"]`)
					: element
				let first = true
				while (current) {
					const styles = getComputedStyle(current)
					assertSupported(current, styles, first && current.childElementCount === 0)
					const color = first ? styleValue(styles, backgroundProperty) : styles.backgroundColor
					const propertyOpacity =
						first && backgroundProperty === "fill"
							? Number(styles.fillOpacity)
							: first && backgroundProperty === "stroke"
								? Number(styles.strokeOpacity)
								: 1
					backgroundLayers.push({ color, opacity: Number(styles.opacity) * propertyOpacity })
					current = current.parentElement
					first = false
				}
				return {
					foreground: styleValue(foregroundStyles, foregroundProperty),
					foregroundOpacity:
						Number(foregroundStyles.opacity) *
						(foregroundProperty === "fill"
							? Number(foregroundStyles.fillOpacity)
							: foregroundProperty === "stroke"
								? Number(foregroundStyles.strokeOpacity)
								: 1),
					backgroundLayers,
					fontSize: Number.parseFloat(foregroundStyles.fontSize),
					fontWeight: Number.parseInt(foregroundStyles.fontWeight, 10) || 400,
				}
			},
			{
				backgroundToken,
				foregroundProperty: options.foregroundProperty ?? "color",
				backgroundProperty: options.backgroundProperty ?? "background-color",
			},
		)
	} finally {
		if (options.background && backgroundToken) {
			await options.background.evaluate((element) => element.removeAttribute("data-contrast-background"))
		}
	}

	let effectiveBackground: RgbaColor = { r: 0, g: 0, b: 0, a: 0 }
	for (const layer of styles.backgroundLayers.reverse()) {
		const color = parseCssColor(layer.color)
		effectiveBackground = composite({ ...color, a: color.a * layer.opacity }, effectiveBackground)
	}
	if (effectiveBackground.a < 0.999) {
		throw new Error(`${options.label}: effective background is not opaque`)
	}

	const foregroundColor = parseCssColor(styles.foreground)
	const effectiveForeground = composite(
		{ ...foregroundColor, a: foregroundColor.a * styles.foregroundOpacity },
		effectiveBackground,
	)
	const ratio = contrastRatio(effectiveForeground, effectiveBackground)
	const minimum =
		options.minimum === "text" || options.minimum === undefined
			? requiredTextContrast(styles.fontSize, styles.fontWeight)
			: options.minimum
	const diagnostic = `${options.label}: ${ratio.toFixed(2)}:1 (required ${minimum}:1; foreground ${styles.foreground}; background rgba(${effectiveBackground.r.toFixed(0)}, ${effectiveBackground.g.toFixed(0)}, ${effectiveBackground.b.toFixed(0)}, ${effectiveBackground.a.toFixed(2)}))`
	expect(ratio, diagnostic).toBeGreaterThanOrEqual(minimum)
	return { ratio, minimum, foreground: effectiveForeground, background: effectiveBackground }
}
