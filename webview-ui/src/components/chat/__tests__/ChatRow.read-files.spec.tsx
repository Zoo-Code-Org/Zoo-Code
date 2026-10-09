import type { ClineMessage, ClineSayTool } from "@roo-code/types"
import { fireEvent, renderWithExtensionState, screen } from "@/utils/test-utils"
import { ChatRowContent } from "../ChatRow"

const postMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (...args: unknown[]) => postMessage(...args) } }))
vi.mock("@src/components/common/CodeBlock", () => ({ default: () => null }))

function renderApproval(tool: ClineSayTool) {
	const message: ClineMessage = { type: "ask", ask: "tool", ts: 1, partial: false, text: JSON.stringify(tool) }
	return renderWithExtensionState(
		<ChatRowContent
			message={message}
			isExpanded={false}
			isLast={true}
			isStreaming={false}
			onToggleExpand={() => {}}
			onSuggestionClick={() => {}}
			onBatchFileResponse={() => {}}
			onFollowUpUnmount={() => {}}
			isFollowUpAnswered={false}
		/>,
	)
}

describe("batch reader reuses independent readFile approval rows", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})
	it("renders the current entry's range and opens its starting line", () => {
		renderApproval({
			tool: "readFile",
			path: "source.ts",
			reason: "(indentation mode at line 42)",
			content: "/workspace/source.ts",
			startLine: 42,
			isOutsideWorkspace: false,
		})
		expect(screen.getByText(/indentation mode at line 42/)).toBeInTheDocument()
		fireEvent.click(screen.getByText(/source\.ts/))
		expect(postMessage).toHaveBeenCalledWith({
			type: "openFile",
			text: "/workspace/source.ts",
			values: { line: 42 },
		})
	})
	it("renders outside-workspace treatment for the next entry rather than inheriting the first approval", () => {
		renderApproval({
			tool: "readFile",
			path: "../outside.ts",
			reason: "(lines 5-8)",
			content: "/outside.ts",
			startLine: 5,
			isOutsideWorkspace: true,
		})
		expect(screen.getByText(/lines 5-8/)).toBeInTheDocument()
		expect(screen.getByText("fileOperations.wantsToReadOutsideWorkspace")).toBeInTheDocument()
	})
})
