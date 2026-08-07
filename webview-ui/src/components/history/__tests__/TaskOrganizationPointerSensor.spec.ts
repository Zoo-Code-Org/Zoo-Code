import { describe, it, expect } from "vitest"
import type { PointerEvent } from "react"

import {
	TaskOrganizationPointerSensor,
	isInteractivePointerTarget,
	INTERACTIVE_SELECTOR,
} from "../TaskOrganizationPointerSensor"

const makePointerEvent = (target: EventTarget | null): PointerEvent =>
	({ nativeEvent: { target } as unknown as globalThis.PointerEvent }) as unknown as PointerEvent

const makeOptions = () => ({}) as Parameters<(typeof TaskOrganizationPointerSensor.activators)[0]["handler"]>[1]

describe("isInteractivePointerTarget", () => {
	it("returns false for null target", () => {
		expect(isInteractivePointerTarget(null)).toBe(false)
	})

	it("returns false for non-Element target", () => {
		expect(isInteractivePointerTarget(window)).toBe(false)
	})

	it("returns false for a plain div", () => {
		const div = document.createElement("div")
		expect(isInteractivePointerTarget(div)).toBe(false)
	})

	it("returns true for a button", () => {
		const button = document.createElement("button")
		expect(isInteractivePointerTarget(button)).toBe(true)
	})

	it("returns true for an element inside a button", () => {
		const button = document.createElement("button")
		const span = document.createElement("span")
		button.appendChild(span)
		document.body.appendChild(button)
		expect(isInteractivePointerTarget(span)).toBe(true)
		button.remove()
	})

	it("returns true for input, anchor, and role=menuitem", () => {
		const input = document.createElement("input")
		expect(isInteractivePointerTarget(input)).toBe(true)

		const anchor = document.createElement("a")
		expect(isInteractivePointerTarget(anchor)).toBe(true)

		const menuItem = document.createElement("div")
		menuItem.setAttribute("role", "menuitem")
		expect(isInteractivePointerTarget(menuItem)).toBe(true)
	})

	it("returns true for role=checkbox and data-no-drag", () => {
		const checkbox = document.createElement("div")
		checkbox.setAttribute("role", "checkbox")
		expect(isInteractivePointerTarget(checkbox)).toBe(true)

		const noDrag = document.createElement("div")
		noDrag.setAttribute("data-no-drag", "")
		expect(isInteractivePointerTarget(noDrag)).toBe(true)
	})

	it("INTERACTIVE_SELECTOR covers required interactive types", () => {
		expect(INTERACTIVE_SELECTOR).toContain("button")
		expect(INTERACTIVE_SELECTOR).toContain("input")
		expect(INTERACTIVE_SELECTOR).toContain("a")
		expect(INTERACTIVE_SELECTOR).toContain("[role='menuitem']")
		expect(INTERACTIVE_SELECTOR).toContain("[role='checkbox']")
	})
})

describe("TaskOrganizationPointerSensor activator", () => {
	const handler = TaskOrganizationPointerSensor.activators[0].handler

	it("rejects drag when pointerdown lands on a button", () => {
		const button = document.createElement("button")
		document.body.appendChild(button)
		expect(handler(makePointerEvent(button), makeOptions())).toBe(false)
		button.remove()
	})

	it("rejects drag when pointerdown lands inside a button", () => {
		const button = document.createElement("button")
		const icon = document.createElement("span")
		button.appendChild(icon)
		document.body.appendChild(button)
		expect(handler(makePointerEvent(icon), makeOptions())).toBe(false)
		button.remove()
	})

	it("rejects drag for checkbox, anchor, and menuitem targets", () => {
		for (const makeEl of [
			() => {
				const el = document.createElement("input")
				el.type = "checkbox"
				return el
			},
			() => document.createElement("a"),
			() => {
				const el = document.createElement("div")
				el.setAttribute("role", "menuitem")
				return el
			},
		]) {
			const el = makeEl()
			document.body.appendChild(el)
			expect(handler(makePointerEvent(el), makeOptions())).toBe(false)
			el.remove()
		}
	})

	it("delegates to PointerSensor for non-interactive targets", () => {
		const div = document.createElement("div")
		document.body.appendChild(div)
		const result = handler(makePointerEvent(div), makeOptions())
		expect(typeof result).toBe("boolean")
		div.remove()
	})

	it("stops upward traversal when encountering a draggable-entry or manual-folder boundary", () => {
		const container = document.createElement("div")
		container.setAttribute("data-testid", "draggable-entry-task-1")

		const childSpan = document.createElement("span")
		container.appendChild(childSpan)

		const outerButton = document.createElement("button")
		outerButton.appendChild(container)
		document.body.appendChild(outerButton)

		// Traversal stops at container, ignoring outerButton
		expect(isInteractivePointerTarget(childSpan)).toBe(false)
		outerButton.remove()
	})
})
