import React from "react"
import { render, screen, fireEvent, act } from "@/utils/test-utils"
import type { ParallelSubtaskInfo } from "@roo-code/types"

import ParallelSubtasksBlock, { ParallelSubtasksPreview, formatElapsed } from "../ParallelSubtasksBlock"

const mockPostMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (msg: unknown) => mockPostMessage(msg),
	},
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => {
			const map: Record<string, string> = {
				"chat:parallelSubtasks.title": "Parallel investigations",
				"chat:parallelSubtasks.progress": "{{completed}} of {{total}} complete",
				"chat:parallelSubtasks.status.queued": "Queued",
				"chat:parallelSubtasks.status.running": "Running",
				"chat:parallelSubtasks.status.completed": "Completed",
				"chat:parallelSubtasks.status.failed": "Failed",
				"chat:parallelSubtasks.status.aborted": "Aborted",
				"chat:parallelSubtasks.openReport": "Report",
				"chat:parallelSubtasks.openDebugLog": "JSON log",
				"chat:parallelSubtasks.goToTask": "Go to task",
				"chat:parallelSubtasks.noReport": "No report available yet",
				"chat:task.expand": "Expand task",
				"chat:task.collapse": "Collapse task",
			}
			let value = map[key] ?? key
			if (params) {
				for (const [k, v] of Object.entries(params)) {
					value = value.replaceAll(`{{${k}}}`, String(v))
				}
			}
			return value
		},
	}),
}))

const BASE_TIME = new Date("2026-11-19T00:00:00Z").getTime()

const subtask = (overrides: Partial<ParallelSubtaskInfo> & { taskId: string }): ParallelSubtaskInfo => ({
	label: overrides.taskId,
	mode: "code",
	status: "queued",
	...overrides,
})

describe("ParallelSubtasksBlock", () => {
	beforeEach(() => {
		mockPostMessage.mockClear()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	describe("rendering", () => {
		it("renders one row per subtask in request order", () => {
			const subtasks: ParallelSubtaskInfo[] = [
				subtask({ taskId: "child-3", label: "Third", mode: "debug", status: "failed" }),
				subtask({ taskId: "child-1", label: "First", mode: "code", status: "completed" }),
				subtask({ taskId: "child-2", label: "Second", mode: "architect", status: "queued" }),
			]
			const { container } = render(<ParallelSubtasksBlock subtasks={subtasks} partial={false} />)

			const rows = container.querySelectorAll("[data-testid^='parallel-subtask-row-']")
			expect(rows).toHaveLength(3)
			expect(rows[0].getAttribute("data-testid")).toBe("parallel-subtask-row-child-3")
			expect(rows[1].getAttribute("data-testid")).toBe("parallel-subtask-row-child-1")
			expect(rows[2].getAttribute("data-testid")).toBe("parallel-subtask-row-child-2")

			expect(screen.getByText("Third")).toBeInTheDocument()
			expect(screen.getByTestId("parallel-subtask-mode-child-1")).toHaveTextContent("code")
			expect(screen.getByTestId("parallel-subtask-mode-child-2")).toHaveTextContent("architect")
		})

		it.each([
			["queued", "Queued"],
			["running", "Running"],
			["completed", "Completed"],
			["failed", "Failed"],
			["aborted", "Aborted"],
		] as const)("renders the %s status icon with its label", (status, label) => {
			render(<ParallelSubtasksBlock subtasks={[subtask({ taskId: "child-1", status })]} partial={false} />)
			expect(screen.getByLabelText(label)).toBeInTheDocument()
		})

		it("shows the summary once completed and the error once failed", () => {
			render(
				<ParallelSubtasksBlock
					subtasks={[
						subtask({ taskId: "ok", status: "completed", summary: "Found 3 call sites" }),
						subtask({ taskId: "bad", status: "failed", error: "Output token limit" }),
					]}
					partial={false}
				/>,
			)
			expect(screen.getByTestId("parallel-subtask-line-ok")).toHaveTextContent("Found 3 call sites")
			expect(screen.getByTestId("parallel-subtask-line-bad")).toHaveTextContent("Output token limit")
		})
	})

	describe("progress header", () => {
		it("shows the live count while partial and the final count when done", () => {
			const subtasks: ParallelSubtaskInfo[] = [
				subtask({ taskId: "child-1", status: "completed" }),
				subtask({ taskId: "child-2", status: "running", startedAt: BASE_TIME }),
				subtask({ taskId: "child-3", status: "queued" }),
			]
			const { rerender } = render(<ParallelSubtasksBlock subtasks={subtasks} partial={true} />)
			expect(screen.getByText("1 of 3 complete")).toBeInTheDocument()

			rerender(
				<ParallelSubtasksBlock
					subtasks={subtasks.map((s) => ({ ...s, status: "completed" as const }))}
					partial={false}
				/>,
			)
			expect(screen.getByText("3 of 3 complete")).toBeInTheDocument()
		})
	})

	describe("elapsed time", () => {
		it("ticks the elapsed badge while a child is running", () => {
			vi.useFakeTimers()
			vi.setSystemTime(BASE_TIME + 10_000)
			render(
				<ParallelSubtasksBlock
					subtasks={[subtask({ taskId: "child-1", status: "running", startedAt: BASE_TIME })]}
					partial={true}
				/>,
			)
			expect(screen.getByTestId("parallel-subtask-elapsed-child-1")).toHaveTextContent("10s")

			act(() => {
				vi.advanceTimersByTime(5_000)
			})
			expect(screen.getByTestId("parallel-subtask-elapsed-child-1")).toHaveTextContent("15s")
		})

		it("hides the elapsed badge for non-running rows", () => {
			vi.useFakeTimers()
			vi.setSystemTime(BASE_TIME + 10_000)
			render(
				<ParallelSubtasksBlock
					subtasks={[
						subtask({ taskId: "child-1", status: "queued", startedAt: BASE_TIME }),
						subtask({
							taskId: "child-2",
							status: "completed",
							startedAt: BASE_TIME,
							finishedAt: BASE_TIME + 3_000,
						}),
					]}
					partial={true}
				/>,
			)
			expect(screen.queryByTestId("parallel-subtask-elapsed-child-1")).not.toBeInTheDocument()
			expect(screen.queryByTestId("parallel-subtask-elapsed-child-2")).not.toBeInTheDocument()
		})
	})

	describe("buttons", () => {
		it("posts openFile with the report path when Report is clicked", () => {
			render(
				<ParallelSubtasksBlock
					subtasks={[
						subtask({
							taskId: "child-1",
							status: "completed",
							reportPath: "/ws/.zoocode/subtask-reports/p/a.md",
						}),
					]}
					partial={false}
				/>,
			)
			fireEvent.click(screen.getByRole("button", { name: "Report" }))
			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "openFile",
				text: "/ws/.zoocode/subtask-reports/p/a.md",
			})
		})

		it("disables Report when no report path exists", () => {
			render(
				<ParallelSubtasksBlock subtasks={[subtask({ taskId: "child-1", status: "running" })]} partial={true} />,
			)
			const reportButton = screen.getByRole("button", { name: "Report" })
			expect(reportButton).toBeDisabled()
			fireEvent.click(reportButton)
			expect(mockPostMessage).not.toHaveBeenCalled()
		})

		it("posts openDebugUiHistory with the child taskId when JSON log is clicked", () => {
			render(
				<ParallelSubtasksBlock
					subtasks={[subtask({ taskId: "child-42", status: "failed", error: "boom" })]}
					partial={false}
				/>,
			)
			fireEvent.click(screen.getByRole("button", { name: "JSON log" }))
			expect(mockPostMessage).toHaveBeenCalledWith({ type: "openDebugUiHistory", taskId: "child-42" })
		})

		it("posts showTaskWithId with the child taskId when Go to task is clicked", () => {
			render(
				<ParallelSubtasksBlock
					subtasks={[subtask({ taskId: "child-42", status: "completed", summary: "done" })]}
					partial={false}
				/>,
			)
			fireEvent.click(screen.getByRole("button", { name: "Go to task" }))
			expect(mockPostMessage).toHaveBeenCalledWith({ type: "showTaskWithId", text: "child-42" })
		})
	})

	describe("synthetic rows (F-20)", () => {
		it("hides navigation and debug buttons for a dropped row", () => {
			render(
				<ParallelSubtasksBlock
					subtasks={[
						subtask({
							taskId: "dropped-0",
							status: "failed",
							error: "Dropped: the request exceeded the per-call limit (1 of 2 started)",
						}),
					]}
					partial={false}
				/>,
			)
			expect(screen.queryByRole("button", { name: "JSON log" })).not.toBeInTheDocument()
			expect(screen.queryByRole("button", { name: "Go to task" })).not.toBeInTheDocument()
			expect(screen.getByRole("button", { name: "Report" })).toBeDisabled()
			expect(screen.getByTestId("parallel-subtask-line-dropped-0")).toHaveTextContent("Dropped")
		})

		it("hides navigation and debug buttons for an unregistered failed-handle id", () => {
			render(
				<ParallelSubtasksBlock
					subtasks={[
						subtask({ taskId: "child-1", status: "completed", summary: "done" }),
						subtask({ taskId: "synthetic-uuid", status: "failed", error: "Unknown mode: turbo" }),
					]}
					partial={false}
					childTaskIds={["child-1"]}
				/>,
			)
			expect(screen.getByTestId("parallel-subtask-row-synthetic-uuid")).toBeInTheDocument()
			expect(screen.getAllByRole("button", { name: "JSON log" })).toHaveLength(1)
			expect(screen.getAllByRole("button", { name: "Go to task" })).toHaveLength(1)
			fireEvent.click(screen.getByRole("button", { name: "Go to task" }))
			expect(mockPostMessage).toHaveBeenCalledWith({ type: "showTaskWithId", text: "child-1" })
		})

		it("keeps navigation and debug buttons for every registered child", () => {
			render(
				<ParallelSubtasksBlock
					subtasks={[
						subtask({ taskId: "child-1", status: "running", startedAt: BASE_TIME }),
						subtask({ taskId: "child-2", status: "queued" }),
					]}
					partial={true}
					childTaskIds={["child-1", "child-2"]}
				/>,
			)
			expect(screen.getAllByRole("button", { name: "JSON log" })).toHaveLength(2)
			expect(screen.getAllByRole("button", { name: "Go to task" })).toHaveLength(2)
		})
	})

	describe("ParallelSubtasksPreview", () => {
		it("renders one row per requested task with its label, mode and message preview", () => {
			render(
				<ParallelSubtasksPreview
					tasks={[
						{ label: "Investigate parser", mode: "code", message: "Trace how the parser handles braces." },
						{ label: "Check tests", mode: "debug", message: "Find the missing assertion." },
					]}
				/>,
			)

			expect(screen.getByText("Parallel investigations")).toBeInTheDocument()
			expect(screen.getByText("Investigate parser")).toBeInTheDocument()
			expect(screen.getByText("Check tests")).toBeInTheDocument()
			expect(screen.getByTestId("parallel-subtask-request-mode-0")).toHaveTextContent("code")
			expect(screen.getByTestId("parallel-subtask-request-mode-1")).toHaveTextContent("debug")
			expect(screen.getByTestId("parallel-subtask-request-message-0")).toHaveTextContent(
				"Trace how the parser handles braces.",
			)
			expect(screen.getByTestId("parallel-subtask-request-message-1")).toHaveTextContent(
				"Find the missing assertion.",
			)
			expect(screen.getAllByLabelText("Queued")).toHaveLength(2)
		})

		it("keeps the header when no task parsed so the approval row is never invisible", () => {
			render(<ParallelSubtasksPreview tasks={[]} />)
			expect(screen.getByText("Parallel investigations")).toBeInTheDocument()
			expect(screen.queryByTestId("parallel-subtask-request-0")).not.toBeInTheDocument()
		})

		it("reveals the full message through an accessible expand control", () => {
			const message =
				"First line of the request.\nSecond line.\nThird line carries the detail that the two-line preview hides."
			render(<ParallelSubtasksPreview tasks={[{ label: "Long request", mode: "code", message }]} />)

			const preview = screen.getByTestId("parallel-subtask-request-message-0")
			// The compact preview keeps the full text in the DOM and as its title,
			// but the visible clamp hides everything past two lines.
			expect(preview.textContent).toBe(message)
			expect(preview).toHaveAttribute("title", message)
			expect(preview.style.display).toBe("-webkit-box")

			const expand = screen.getByRole("button", { name: "Expand task" })
			expect(expand).toHaveAttribute("aria-expanded", "false")
			fireEvent.click(expand)

			const collapse = screen.getByRole("button", { name: "Collapse task" })
			expect(collapse).toHaveAttribute("aria-expanded", "true")
			expect(preview.style.display).toBe("")
			expect(preview.style.getPropertyValue("-webkit-line-clamp")).toBe("")

			fireEvent.click(collapse)
			expect(screen.getByRole("button", { name: "Expand task" })).toHaveAttribute("aria-expanded", "false")
			expect(preview.style.display).toBe("-webkit-box")
		})

		it("expands only the row whose control was clicked", () => {
			render(
				<ParallelSubtasksPreview
					tasks={[
						{ label: "One", mode: "code", message: "First request message." },
						{ label: "Two", mode: "debug", message: "Second request message." },
					]}
				/>,
			)

			fireEvent.click(screen.getAllByRole("button", { name: "Expand task" })[0])

			expect(screen.getByTestId("parallel-subtask-request-message-0").style.display).toBe("")
			expect(screen.getByTestId("parallel-subtask-request-message-1").style.display).toBe("-webkit-box")
			expect(screen.getAllByRole("button", { name: "Collapse task" })).toHaveLength(1)
		})
	})

	describe("formatElapsed", () => {
		it.each([
			[0, "0s"],
			[4_999, "4s"],
			[65_000, "1m 5s"],
			[3_600_000, "1h 0m"],
		] as const)("formats %d ms as %s", (ms, expected) => {
			expect(formatElapsed(ms)).toBe(expected)
		})
	})
})
