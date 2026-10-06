import { expect, type Locator, type Page } from "@playwright/test"

export const WCAG_TEXT_SPACING = {
	lineHeight: 1.5,
	paragraphSpacing: "2em",
	letterSpacing: "0.12em",
	wordSpacing: "0.16em",
} as const

export const REFLOW_VIEWPORT_WIDTH = 320

interface BoundedLayoutOptions {
	actionRows?: Locator[]
	focusedControl: Locator
}

export function collectBoundedLayoutFailures(element: HTMLElement) {
	const tolerance = 1
	const viewportWidth = document.documentElement.clientWidth
	const isScreenReaderOnly = (candidate: HTMLElement) => {
		let current: HTMLElement | null = candidate
		while (current && element.contains(current)) {
			const styles = getComputedStyle(current)
			if (
				current.classList.contains("sr-only") ||
				(styles.position === "absolute" &&
					current.offsetWidth <= 1 &&
					current.offsetHeight <= 1 &&
					(styles.clip !== "auto" || styles.clipPath !== "none"))
			) {
				return true
			}
			current = current.parentElement
		}
		return false
	}
	const semanticCandidates = Array.from(
		element.querySelectorAll<HTMLElement>(
			"h1, h2, h3, h4, h5, h6, p, label, button, input, textarea, select, [role='button'], [role='checkbox'], [role='combobox'], [role='slider'], [role='textbox']",
		),
	)
	const clippedTextCandidates = Array.from(element.querySelectorAll<HTMLElement>("span, div")).filter((candidate) => {
		const styles = getComputedStyle(candidate)
		const hasDirectText = Array.from(candidate.childNodes).some(
			(node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
		)
		return (
			hasDirectText &&
			(styles.overflowX === "hidden" ||
				styles.overflowX === "clip" ||
				styles.overflowY === "hidden" ||
				styles.overflowY === "clip" ||
				styles.textOverflow === "ellipsis")
		)
	})
	const candidates = [...new Set([...semanticCandidates, ...clippedTextCandidates])].filter(
		(candidate) => candidate.getClientRects().length > 0 && !isScreenReaderOnly(candidate),
	)

	const failures: string[] = []
	if (document.documentElement.scrollWidth > viewportWidth + tolerance)
		failures.push("document overflows horizontally")
	if (document.body.scrollWidth > viewportWidth + tolerance) failures.push("body overflows horizontally")
	if (element.scrollWidth > element.clientWidth + tolerance) failures.push("root overflows horizontally")

	for (const candidate of candidates) {
		const rect = candidate.getBoundingClientRect()
		const styles = getComputedStyle(candidate)
		const name =
			candidate.getAttribute("aria-label") || candidate.textContent?.trim().slice(0, 40) || candidate.tagName
		if (rect.left < -tolerance || rect.right > viewportWidth + tolerance) failures.push(`${name} leaves viewport`)
		if (
			(styles.overflowX === "hidden" || styles.overflowX === "clip") &&
			candidate.scrollWidth > candidate.clientWidth + tolerance
		) {
			failures.push(`${name} clips horizontally`)
		}
		if (
			(styles.overflowY === "hidden" || styles.overflowY === "clip") &&
			candidate.scrollHeight > candidate.clientHeight + tolerance
		) {
			failures.push(`${name} clips vertically`)
		}

		let ancestor = candidate.parentElement
		while (ancestor && element.contains(ancestor)) {
			const ancestorStyles = getComputedStyle(ancestor)
			const clipsX = ancestorStyles.overflowX === "hidden" || ancestorStyles.overflowX === "clip"
			const clipsY = ancestorStyles.overflowY === "hidden" || ancestorStyles.overflowY === "clip"
			if (clipsX || clipsY) {
				const ancestorRect = ancestor.getBoundingClientRect()
				if (
					clipsX &&
					(rect.left < ancestorRect.left - tolerance || rect.right > ancestorRect.right + tolerance)
				)
					failures.push(`${name} is clipped horizontally by an ancestor`)
				if (
					clipsY &&
					(rect.top < ancestorRect.top - tolerance || rect.bottom > ancestorRect.bottom + tolerance)
				)
					failures.push(`${name} is clipped vertically by an ancestor`)
			}
			ancestor = ancestor.parentElement
		}
	}
	return failures
}

export async function expectBoundedLayout(
	page: Page,
	root: Locator,
	{ actionRows = [], focusedControl }: BoundedLayoutOptions,
) {
	await page.setViewportSize({ width: REFLOW_VIEWPORT_WIDTH, height: 640 })
	await page.evaluate((spacing) => {
		document.querySelector("#playwright-wcag-text-spacing")?.remove()
		const style = document.createElement("style")
		style.id = "playwright-wcag-text-spacing"
		style.textContent = `
			#root, #root * { line-height: ${spacing.lineHeight} !important; letter-spacing: ${spacing.letterSpacing} !important; word-spacing: ${spacing.wordSpacing} !important; }
			#root p { margin-bottom: ${spacing.paragraphSpacing} !important; }
		`
		document.head.append(style)
	}, WCAG_TEXT_SPACING)

	await expect.poll(() => root.evaluate(collectBoundedLayoutFailures)).toEqual([])

	for (const actionRow of actionRows) {
		const containment = await actionRow.evaluate((row) => {
			const rowRect = row.getBoundingClientRect()
			const controls = Array.from(
				row.querySelectorAll<HTMLElement>(
					"button, input, textarea, select, [role='button'], [role='combobox']",
				),
			).filter((control) => control.getClientRects().length > 0)
			return {
				controlCount: controls.length,
				overflows: row.scrollWidth > row.clientWidth + 1,
				controlsContained: controls.every((control) => {
					const rect = control.getBoundingClientRect()
					return rect.left >= rowRect.left - 1 && rect.right <= rowRect.right + 1
				}),
			}
		})
		expect(containment).toEqual({ controlCount: expect.any(Number), overflows: false, controlsContained: true })
		expect(containment.controlCount).toBeGreaterThan(0)
	}

	await focusedControl.focus()
	await expect(focusedControl).toBeFocused()
	await expect
		.poll(() =>
			focusedControl.evaluate((control) => {
				const rect = control.getBoundingClientRect()
				return (
					rect.left >= 0 &&
					rect.right <= document.documentElement.clientWidth &&
					rect.top >= 0 &&
					rect.bottom <= innerHeight
				)
			}),
		)
		.toBe(true)
}
