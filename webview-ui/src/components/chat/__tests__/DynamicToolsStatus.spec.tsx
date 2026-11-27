import { fireEvent, render, screen } from "@testing-library/react"
import type { McpToolStatus } from "@roo-code/types"
import { DynamicToolsStatus } from "../DynamicToolsStatus"

let mcpToolStatus: McpToolStatus | null | undefined
vi.mock("@src/context/ExtensionStateContext", () => ({ useExtensionState: () => ({ mcpToolStatus }) }))
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, values: { attached: number; total: number }) => `${key} ${values.attached}/${values.total}`,
	}),
}))

describe("DynamicToolsStatus", () => {
	it.each([undefined, null])("shows nothing when the status is %s", (status) => {
		mcpToolStatus = status
		const { container } = render(<DynamicToolsStatus />)
		expect(container).toBeEmptyDOMElement()
	})

	it("shows the counts and expands the attached tool names", () => {
		mcpToolStatus = { attachedToolNames: ["mcp--s--a", "mcp--s--b"], totalScoped: 60 }
		render(<DynamicToolsStatus />)
		const toggle = screen.getByRole("button", { name: "chat:dynamicToolsStatus.summary 2/60" })
		expect(toggle).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByRole("listitem")).not.toBeInTheDocument()

		fireEvent.click(toggle)

		expect(toggle).toHaveAttribute("aria-expanded", "true")
		expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["mcp--s--a", "mcp--s--b"])
	})
})
