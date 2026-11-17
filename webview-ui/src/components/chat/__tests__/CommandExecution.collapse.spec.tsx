import { act, fireEvent, screen, renderWithExtensionState } from "@/utils/test-utils"
import { CommandExecution } from "../CommandExecution"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("../../common/CodeBlock", () => ({
	default: ({ source }: { source: string }) => <div>{source}</div>,
}))
vi.mock("../TerminalOutput", () => ({
	TerminalOutput: ({ content }: { content: string }) => <div data-testid="terminal-output">{content}</div>,
}))
vi.mock("../CommandPatternSelector", () => ({ CommandPatternSelector: () => null }))

const sendStatus = (data: Record<string, unknown>) => {
	act(() =>
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "commandExecutionStatus",
					text: JSON.stringify({ executionId: "collapse-test", ...data }),
				},
			}),
		),
	)
}
const setup = (collapseCommandOutputByDefault?: boolean, terminalShellIntegrationDisabled = true) =>
	renderWithExtensionState(
		<CommandExecution executionId="collapse-test" text="npm test\nOutput:\nInitial output" />,
		{
			state: { collapseCommandOutputByDefault, terminalShellIntegrationDisabled },
		},
	)
const outputContainer = () => screen.getByTestId("terminal-output").parentElement

describe("command output collapse preference", () => {
	it.each([
		[true, true, true],
		[true, false, true],
		[false, true, false],
		[false, false, true],
		[undefined, true, false],
		[undefined, false, true],
	])("applies preference %s with inline mode %s", (preference, inline, collapsed) => {
		setup(preference, inline)
		expect(outputContainer()).toHaveClass(collapsed ? "max-h-0" : "max-h-[100%]")
	})
	it("keeps streaming and completed output collapsed until manually expanded", () => {
		setup(true)
		sendStatus({ status: "started", pid: 123 })
		sendStatus({ status: "output", output: "Streaming output" })
		expect(screen.getByTestId("terminal-output")).toHaveTextContent("Streaming output")
		expect(outputContainer()).toHaveClass("max-h-0")
		fireEvent.click(screen.getAllByRole("button").at(-1)!)
		expect(outputContainer()).not.toHaveClass("max-h-0")
		sendStatus({ status: "output", output: "More output" })
		sendStatus({ status: "exited", exitCode: 0 })
		expect(outputContainer()).not.toHaveClass("max-h-0")
		fireEvent.click(screen.getAllByRole("button").at(-1)!)
		expect(outputContainer()).toHaveClass("max-h-0")
	})

	it("preserves a manual expansion through fallback and new output", () => {
		setup(true, false)
		fireEvent.click(screen.getAllByRole("button").at(-1)!)
		sendStatus({ status: "fallback" })
		sendStatus({ status: "output", output: "Fallback output" })
		expect(outputContainer()).not.toHaveClass("max-h-0")
	})
	it.each([true, false, undefined])("respects preference %s during shell integration fallback", (preference) => {
		setup(preference, false)
		sendStatus({ status: "fallback" })
		expect(outputContainer()).toHaveClass(preference ? "max-h-0" : "max-h-[100%]")
	})
})
