import React from "react"
import { act } from "@testing-library/react"
import { fireEvent, render, screen } from "@/utils/test-utils"
import type { ClineMessage } from "@roo-code/types"
import { TranslationProvider } from "@/i18n/__mocks__/TranslationContext"
import FileChangesPanel from "../components/chat/FileChangesPanel"

const mockPostMessage = vi.fn()

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (...args: unknown[]) => mockPostMessage(...args),
	},
}))

// Mock i18n to return readable header with count
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: { count?: number }) => {
			if (key === "chat:fileChangesInConversation.header" && opts?.count != null) {
				return `${opts.count} file(s) changed in this conversation`
			}
			return key
		},
	}),
}))

// Lightweight mock so we don't pull in CodeBlock/DiffView
vi.mock("@src/components/common/CodeAccordion", () => ({
	default: ({
		path,
		code,
		isExpanded,
		onToggleExpand,
	}: {
		path?: string
		code?: string
		isExpanded: boolean
		onToggleExpand: () => void
	}) => (
		<div data-testid="code-accordian">
			<span data-testid="accordian-path">{path}</span>
			<pre data-testid="accordian-code">{code}</pre>
			<button type="button" onClick={onToggleExpand} data-testid="accordian-toggle">
				{isExpanded ? "expanded" : "collapsed"}
			</button>
		</div>
	),
}))

function createFileEditMessage(
	path: string,
	diff: string,
	diffStats?: { added: number; removed: number },
): ClineMessage {
	return {
		type: "ask",
		ask: "tool",
		ts: Date.now(),
		partial: false,
		isAnswered: true,
		text: JSON.stringify({
			tool: "appliedDiff",
			path,
			diff,
			...(diffStats && { diffStats }),
		}),
	}
}

function renderPanel(messages: ClineMessage[] | undefined, taskId?: string) {
	return render(
		<TranslationProvider>
			<FileChangesPanel clineMessages={messages} taskId={taskId} />
		</TranslationProvider>,
	)
}

describe("FileChangesPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders nothing when clineMessages is undefined", () => {
		const { container } = renderPanel(undefined)
		expect(container.firstChild).toBeNull()
	})

	it("renders nothing when clineMessages is empty", () => {
		const { container } = renderPanel([])
		expect(container.firstChild).toBeNull()
	})

	it("renders nothing when there are no file-edit messages", () => {
		const messages: ClineMessage[] = [
			{
				type: "say",
				say: "text",
				ts: Date.now(),
				partial: false,
				text: "hello",
			},
			{
				type: "ask",
				ask: "tool",
				ts: Date.now(),
				partial: false,
				text: JSON.stringify({ tool: "read_file", path: "x.ts" }),
			},
		]
		const { container } = renderPanel(messages)
		expect(container.firstChild).toBeNull()
	})

	it("renders nothing when file-edit ask tool is not approved (isAnswered false or missing)", () => {
		const messages: ClineMessage[] = [
			{
				type: "ask",
				ask: "tool",
				ts: Date.now(),
				partial: false,
				text: JSON.stringify({
					tool: "appliedDiff",
					path: "src/foo.ts",
					diff: "+line",
				}),
			},
		]
		const { container } = renderPanel(messages)
		expect(container.firstChild).toBeNull()
	})

	it("renders panel with header when there is one file edit", () => {
		const messages = [createFileEditMessage("src/foo.ts", "@@ -1 +1 @@\n+line")]
		renderPanel(messages)

		expect(screen.getByText("1 file(s) changed in this conversation")).toBeInTheDocument()
		// Expand panel so file row is in DOM (CollapsibleContent may not render when closed in some setups)
		fireEvent.click(screen.getByText("1 file(s) changed in this conversation").closest("button")!)
		expect(screen.getByTestId("accordian-path")).toHaveTextContent("src/foo.ts")
	})

	it("renders one row per unique path when multiple files edited", () => {
		const messages = [createFileEditMessage("src/a.ts", "diff a"), createFileEditMessage("src/b.ts", "diff b")]
		renderPanel(messages)

		expect(screen.getByText("2 file(s) changed in this conversation")).toBeInTheDocument()
		// Expand panel so file rows are rendered
		fireEvent.click(screen.getByText("2 file(s) changed in this conversation").closest("button")!)
		const paths = screen.getAllByTestId("accordian-path")
		expect(paths).toHaveLength(2)
		expect(paths.map((el) => el.textContent)).toEqual(expect.arrayContaining(["src/a.ts", "src/b.ts"]))
	})

	it("collapsed by default: panel trigger shows chevron and expanding reveals file rows", () => {
		const messages = [createFileEditMessage("src/foo.ts", "diff")]
		renderPanel(messages)

		// Header visible
		const headerText = screen.getByText("1 file(s) changed in this conversation")
		expect(headerText).toBeInTheDocument()
		// Trigger is the button that contains the header text
		const trigger = headerText.closest("button")
		expect(trigger).toBeInTheDocument()

		// Expand panel
		fireEvent.click(trigger!)
		expect(screen.getByTestId("accordian-path")).toHaveTextContent("src/foo.ts")
	})

	it("toggling a file row expand calls onToggleExpand", () => {
		const messages = [createFileEditMessage("src/foo.ts", "diff")]
		renderPanel(messages)

		// Expand panel first so the file row is rendered
		const headerText = screen.getByText("1 file(s) changed in this conversation")
		fireEvent.click(headerText.closest("button")!)

		const accordianToggle = screen.getByTestId("accordian-toggle")
		expect(accordianToggle).toHaveTextContent("collapsed")
		fireEvent.click(accordianToggle)
		expect(accordianToggle).toHaveTextContent("expanded")
	})

	it("hides aggregate stats when no diffStats are present", () => {
		const messages = [createFileEditMessage("src/a.ts", "diff a"), createFileEditMessage("src/b.ts", "diff b")]
		renderPanel(messages)

		expect(screen.queryByTestId("total-added")).not.toBeInTheDocument()
		expect(screen.queryByTestId("total-removed")).not.toBeInTheDocument()
	})

	it("shows aggregated + and - totals in the header when diffStats are present", () => {
		const messages = [
			createFileEditMessage("src/a.ts", "diff a", { added: 3, removed: 1 }),
			createFileEditMessage("src/b.ts", "diff b", { added: 2, removed: 5 }),
		]
		renderPanel(messages)

		expect(screen.getByTestId("total-added")).toHaveTextContent("+5")
		expect(screen.getByTestId("total-removed")).toHaveTextContent("-6")
	})
	describe("original content omitted by the extension", () => {
		const TS = 1234

		function createEditWithOriginal(payload: Record<string, unknown>): ClineMessage {
			return {
				type: "ask",
				ask: "tool",
				ts: TS,
				partial: false,
				isAnswered: true,
				text: JSON.stringify({
					tool: "appliedDiff",
					path: "src/foo.ts",
					diff: "the recorded diff",
					...payload,
				}),
			}
		}

		function expandRow() {
			fireEvent.click(screen.getByText("1 file(s) changed in this conversation").closest("button")!)
			fireEvent.click(screen.getByTestId("accordian-toggle"))
		}

		function respond(message: Record<string, unknown>) {
			act(() => {
				window.dispatchEvent(new MessageEvent("message", { data: message }))
			})
		}

		const requestsOfType = (type: string) =>
			mockPostMessage.mock.calls.map(([m]) => m).filter((m: { type: string }) => m.type === type)

		it("requests nothing until a row is expanded, then asks for the final and the original content", () => {
			renderPanel([createEditWithOriginal({ originalContentLength: 5000 })])
			fireEvent.click(screen.getByText("1 file(s) changed in this conversation").closest("button")!)

			expect(mockPostMessage).not.toHaveBeenCalled()

			fireEvent.click(screen.getByTestId("accordian-toggle"))

			expect(requestsOfType("readFileContent")).toEqual([{ type: "readFileContent", text: "src/foo.ts" }])
			expect(requestsOfType("readOriginalContent")).toEqual([
				{ type: "readOriginalContent", messageTs: TS, messageId: undefined, taskId: undefined },
			])
		})

		it("shows the merged diff once both the original and the final content arrive", () => {
			renderPanel([createEditWithOriginal({ originalContentLength: 5000 })])
			expandRow()

			expect(screen.getByTestId("accordian-code")).toHaveTextContent("the recorded diff")

			respond({ type: "fileContent", fileContent: { path: "src/foo.ts", content: "new line\n" } })
			expect(screen.getByTestId("accordian-code")).toHaveTextContent("the recorded diff")

			respond({ type: "originalContent", originalContentInfo: { ts: TS, content: "old line\n" } })
			expect(screen.getByTestId("accordian-code")).toHaveTextContent("-old line")
			expect(screen.getByTestId("accordian-code")).toHaveTextContent("+new line")
		})

		it("keeps the recorded diff when the original cannot be loaded", () => {
			renderPanel([createEditWithOriginal({ originalContentLength: 5000 })])
			expandRow()

			respond({ type: "fileContent", fileContent: { path: "src/foo.ts", content: "new line\n" } })
			respond({ type: "originalContent", originalContentInfo: { ts: TS, content: null } })

			expect(screen.getByTestId("accordian-code")).toHaveTextContent("the recorded diff")
			expect(requestsOfType("readOriginalContent")).toHaveLength(1)
		})

		it("does not request the original when it is already inline", () => {
			renderPanel([createEditWithOriginal({ originalContent: "old line\n" })])
			expandRow()

			expect(requestsOfType("readOriginalContent")).toHaveLength(0)

			respond({ type: "fileContent", fileContent: { path: "src/foo.ts", content: "new line\n" } })
			expect(screen.getByTestId("accordian-code")).toHaveTextContent("-old line")
			expect(screen.getByTestId("accordian-code")).toHaveTextContent("+new line")
		})

		it("requests nothing for an edit that has no original", () => {
			renderPanel([createEditWithOriginal({})])
			expandRow()

			expect(mockPostMessage).not.toHaveBeenCalled()
		})

		it("requests and matches originals by messageId when messages share a ts", () => {
			const edit = (path: string, messageId: string): ClineMessage => ({
				...createEditWithOriginal({ path, originalContentLength: 5000 }),
				messageId,
			})
			renderPanel([edit("src/a.ts", "id-a"), edit("src/b.ts", "id-b")], "task-1")
			fireEvent.click(screen.getByText("2 file(s) changed in this conversation").closest("button")!)
			screen.getAllByTestId("accordian-toggle").forEach((toggle) => fireEvent.click(toggle))

			expect(requestsOfType("readOriginalContent")).toEqual([
				{ type: "readOriginalContent", messageTs: TS, messageId: "id-a", taskId: "task-1" },
				{ type: "readOriginalContent", messageTs: TS, messageId: "id-b", taskId: "task-1" },
			])

			respond({ type: "fileContent", fileContent: { path: "src/a.ts", content: "new a\n" } })
			respond({ type: "fileContent", fileContent: { path: "src/b.ts", content: "new b\n" } })
			respond({
				type: "originalContent",
				originalContentInfo: { ts: TS, messageId: "id-b", taskId: "task-1", content: "old b\n" },
			})

			const [a, b] = screen.getAllByTestId("accordian-code")
			expect(a).toHaveTextContent("the recorded diff")
			expect(b).toHaveTextContent("-old b")
		})

		it("requests the original again when the task id arrives after a request is already pending", () => {
			const messages = [createEditWithOriginal({ originalContentLength: 5000 })]
			const { rerender } = renderPanel(messages)
			expandRow()
			expect(requestsOfType("readOriginalContent")).toHaveLength(1)

			rerender(
				<TranslationProvider>
					<FileChangesPanel clineMessages={messages} taskId="task-1" />
				</TranslationProvider>,
			)
			fireEvent.click(screen.getByTestId("accordian-toggle"))

			const requests = requestsOfType("readOriginalContent")
			expect(requests).toHaveLength(2)
			expect(requests[1]).toMatchObject({ taskId: "task-1" })
		})

		it("does not send a duplicate request when switching A -> B -> A before the first response arrives", () => {
			const messages = [createEditWithOriginal({ originalContentLength: 5000 })]
			const panel = (taskId: string) => (
				<TranslationProvider>
					<FileChangesPanel clineMessages={messages} taskId={taskId} />
				</TranslationProvider>
			)
			const { rerender } = renderPanel(messages, "task-A")
			expandRow()
			expect(requestsOfType("readOriginalContent")).toHaveLength(1)

			rerender(panel("task-B"))
			rerender(panel("task-A"))
			fireEvent.click(screen.getByTestId("accordian-toggle"))

			expect(requestsOfType("readOriginalContent").filter((m) => m.taskId === "task-A")).toHaveLength(1)

			respond({ type: "fileContent", fileContent: { path: "src/foo.ts", content: "new line\n" } })
			respond({
				type: "originalContent",
				originalContentInfo: { ts: TS, taskId: "task-A", content: "old line\n" },
			})
			expect(screen.getByTestId("accordian-code")).toHaveTextContent("-old line")
		})

		it("requests again after a response that arrived for a task that is no longer current", () => {
			const messages = [createEditWithOriginal({ originalContentLength: 5000 })]
			const panel = (taskId: string) => (
				<TranslationProvider>
					<FileChangesPanel clineMessages={messages} taskId={taskId} />
				</TranslationProvider>
			)
			const { rerender } = renderPanel(messages, "task-A")
			expandRow()

			rerender(panel("task-B"))
			respond({
				type: "originalContent",
				originalContentInfo: { ts: TS, taskId: "task-A", content: "old line\n" },
			})
			rerender(panel("task-A"))
			fireEvent.click(screen.getByTestId("accordian-toggle"))

			expect(requestsOfType("readOriginalContent").filter((m) => m.taskId === "task-A")).toHaveLength(2)
		})

		it("ignores an original answered for a different task", () => {
			renderPanel([createEditWithOriginal({ originalContentLength: 5000 })], "task-1")
			expandRow()

			respond({ type: "fileContent", fileContent: { path: "src/foo.ts", content: "new line\n" } })
			respond({
				type: "originalContent",
				originalContentInfo: { ts: TS, taskId: "task-2", content: "old line\n" },
			})

			expect(screen.getByTestId("accordian-code")).toHaveTextContent("the recorded diff")
		})

		it("ignores an original for a different message", () => {
			renderPanel([createEditWithOriginal({ originalContentLength: 5000 })])
			expandRow()

			respond({ type: "fileContent", fileContent: { path: "src/foo.ts", content: "new line\n" } })
			respond({ type: "originalContent", originalContentInfo: { ts: TS + 1, content: "old line\n" } })

			expect(screen.getByTestId("accordian-code")).toHaveTextContent("the recorded diff")
		})
	})
})
