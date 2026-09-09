import { fireEvent, render, screen } from "@/utils/test-utils"
import { CircleHelp } from "lucide-react"
import { describe, expect, test, vi } from "vitest"

import { IconButton } from "../IconButton"
import { LucideIconButton } from "../LucideIconButton"

describe("chat control buttons", () => {
	test("invokes enabled codicon controls", () => {
		const onClick = vi.fn()
		render(<IconButton iconClass="codicon-settings-gear" title="Settings" tooltip={false} onClick={onClick} />)

		fireEvent.click(screen.getByRole("button", { name: "Settings" }))
		expect(onClick).toHaveBeenCalledOnce()
	})

	test("keeps disabled codicon controls inert", () => {
		const onClick = vi.fn()
		render(
			<IconButton
				iconClass="codicon-settings-gear"
				title="Settings"
				tooltip={false}
				disabled
				onClick={onClick}
			/>,
		)

		const button = screen.getByRole("button", { name: "Settings" })
		expect(button).toBeDisabled()
		fireEvent.click(button)
		expect(onClick).not.toHaveBeenCalled()
	})

	test("renders enabled and disabled Lucide controls", () => {
		const { rerender } = render(<LucideIconButton icon={CircleHelp} title="Help" tooltip={false} />)
		expect(screen.getByRole("button", { name: "Help" })).toBeEnabled()

		rerender(<LucideIconButton icon={CircleHelp} title="Help" tooltip={false} disabled />)
		expect(screen.getByRole("button", { name: "Help" })).toBeDisabled()
	})
})
