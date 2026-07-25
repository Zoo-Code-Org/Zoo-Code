import type { PointerEvent } from "react"
import { PointerSensor } from "@dnd-kit/core"
import type { PointerSensorOptions } from "@dnd-kit/core"

/**
 * Selector matching interactive descendants that must NOT initiate a drag.
 * A pointerdown that lands on (or inside) any of these elements is rejected,
 * preserving pin/checkbox/expand/menu/rename/delete behavior while the rest
 * of the card body remains draggable.
 */
export const INTERACTIVE_SELECTOR = [
	"button",
	"a",
	"input",
	"textarea",
	"select",
	"option",
	"[role='checkbox']",
	"[role='menuitem']",
	"[role='switch']",
	"[role='link']",
	"[role='option']",
	"[contenteditable='true']",
	"[data-no-drag]",
].join(",")

export function isInteractivePointerTarget(target: EventTarget | null): boolean {
	if (!target) return false
	let element: Element | null =
		target instanceof Element ? target : target instanceof Node ? target.parentElement : null

	while (element) {
		// Stop traversing upward once we hit the draggable container wrapper itself.
		if (
			element.hasAttribute("data-testid") &&
			(element.getAttribute("data-testid")?.startsWith("draggable-entry-") ||
				element.getAttribute("data-testid")?.startsWith("manual-folder-"))
		) {
			break
		}

		// Check if the current element matches interactive controls (buttons, inputs, etc.)
		if (element.matches(INTERACTIVE_SELECTOR)) {
			return true
		}

		element = element.parentElement
	}

	return false
}

/**
 * Pointer sensor that rejects drag activation when the pointerdown lands on
 * an interactive descendant (buttons, inputs, links, menu items, etc.).
 * Card-body movement still activates drag via the standard 6px distance
 * constraint configured in useTaskOrganizationDnd.
 */
export class TaskOrganizationPointerSensor extends PointerSensor {
	static activators = [
		{
			eventName: "onPointerDown" as const,
			handler: ({ nativeEvent }: PointerEvent, options: PointerSensorOptions): boolean => {
				if (isInteractivePointerTarget(nativeEvent.target)) return false
				return PointerSensor.activators[0].handler({ nativeEvent } as PointerEvent, options)
			},
		},
	]
}
