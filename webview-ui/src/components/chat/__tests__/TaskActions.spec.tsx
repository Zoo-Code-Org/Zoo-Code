import type { HistoryItem } from "@roo-code/types"

import { render, screen, fireEvent } from "@/utils/test-utils"
import { vscode } from "@/utils/vscode"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useCopyToClipboard } from "@/utils/clipboard"

import { TaskActions } from "../TaskActions"

Object.defineProperty(Element.prototype, "scrollIntoView", {
	value: vi.fn(),
	writable: true,
})

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(),
}))

vi.mock("@/utils/clipboard", () => ({
	useCopyToClipboard: vi.fn(),
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => {
			const translations: Record<string, string> = {
				"chat:task.export": "Export task history",
				"chat:task.delete": "Delete Task (Shift + Click to skip confirmation)",
				"chat:task.openApiHistory": "Open API History",
				"chat:task.openUiHistory": "Open UI History",
				"history:copyPrompt": "Copy",
			}

			return translations[key] || key
		},
	}),
	initReactI18next: {
		type: "3rdParty",
		init: vi.fn(),
	},
}))

vi.mock("pretty-bytes", () => ({
	default: (bytes: number) => `${bytes} B`,
}))

const mockPostMessage = vi.mocked(vscode.postMessage)
const mockUseExtensionState = vi.mocked(useExtensionState)
const mockUseCopyToClipboard = vi.mocked(useCopyToClipboard)

describe("TaskActions", () => {
	const mockItem: HistoryItem = {
		id: "test-task-id",
		number: 1,
		ts: Date.now(),
		task: "Test task",
		tokensIn: 100,
		tokensOut: 200,
		totalCost: 0.01,
		size: 1024,
	}

	beforeEach(() => {
		vi.clearAllMocks()
		mockUseExtensionState.mockReturnValue({
			debug: false,
		} as any)
		mockUseCopyToClipboard.mockReturnValue({
			copyWithFeedback: vi.fn(),
			showCopyFeedback: false,
		})
	})

	it("does not render share button", () => {
		render(<TaskActions item={mockItem} buttonsDisabled={false} />)

		expect(screen.queryByTestId("share-button")).not.toBeInTheDocument()
	})

	it("renders export button", () => {
		render(<TaskActions item={mockItem} buttonsDisabled={false} />)

		expect(screen.getByLabelText("Export task history")).toBeInTheDocument()
	})

	it("sends exportCurrentTask message when export button is clicked", () => {
		render(<TaskActions item={mockItem} buttonsDisabled={false} />)

		fireEvent.click(screen.getByLabelText("Export task history"))

		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "exportCurrentTask",
		})
	})

	it("renders delete button when item has size", () => {
		render(<TaskActions item={mockItem} buttonsDisabled={false} />)

		expect(screen.getByLabelText("Delete Task (Shift + Click to skip confirmation)")).toBeInTheDocument()
	})

	it("does not render delete button when item has no size", () => {
		render(<TaskActions item={{ ...mockItem, size: 0 }} buttonsDisabled={false} />)

		expect(screen.queryByLabelText("Delete Task (Shift + Click to skip confirmation)")).not.toBeInTheDocument()
	})

	it("shows check icon when showCopyFeedback is true", () => {
		const { rerender } = render(<TaskActions item={mockItem} buttonsDisabled={false} />)

		const copyButton = screen.getByLabelText("Copy")
		expect(copyButton.querySelector("svg.lucide-copy")).toBeInTheDocument()
		expect(copyButton.querySelector("svg.lucide-check")).not.toBeInTheDocument()

		mockUseCopyToClipboard.mockReturnValue({
			copyWithFeedback: vi.fn(),
			showCopyFeedback: true,
		})

		rerender(<TaskActions item={mockItem} buttonsDisabled={false} />)

		expect(copyButton.querySelector("svg.lucide-check")).toBeInTheDocument()
		expect(copyButton.querySelector("svg.lucide-copy")).not.toBeInTheDocument()
	})

	it("export and copy buttons remain enabled while delete respects buttonsDisabled", () => {
		const { rerender } = render(<TaskActions item={mockItem} buttonsDisabled={false} />)

		let exportButton = screen.getByLabelText("Export task history")
		let copyButton = screen.getByLabelText("Copy")
		let deleteButton = screen.getByLabelText("Delete Task (Shift + Click to skip confirmation)")

		expect(exportButton).not.toBeDisabled()
		expect(copyButton).not.toBeDisabled()
		expect(deleteButton).not.toBeDisabled()

		rerender(<TaskActions item={mockItem} buttonsDisabled={true} />)

		exportButton = screen.getByLabelText("Export task history")
		copyButton = screen.getByLabelText("Copy")
		deleteButton = screen.getByLabelText("Delete Task (Shift + Click to skip confirmation)")

		expect(exportButton).not.toBeDisabled()
		expect(copyButton).not.toBeDisabled()
		expect(deleteButton).toBeDisabled()
	})

	describe("debug buttons", () => {
		it("does not render debug buttons when debug is false", () => {
			render(<TaskActions item={mockItem} buttonsDisabled={false} />)

			expect(screen.queryByLabelText("Open API History")).not.toBeInTheDocument()
			expect(screen.queryByLabelText("Open UI History")).not.toBeInTheDocument()
		})

		it("renders debug buttons when debug is true and item has id", () => {
			mockUseExtensionState.mockReturnValue({ debug: true } as any)

			render(<TaskActions item={mockItem} buttonsDisabled={false} />)

			expect(screen.getByLabelText("Open API History")).toBeInTheDocument()
			expect(screen.getByLabelText("Open UI History")).toBeInTheDocument()
		})

		it("does not render debug buttons when debug is true but item has no id", () => {
			mockUseExtensionState.mockReturnValue({ debug: true } as any)

			render(<TaskActions item={undefined} buttonsDisabled={false} />)

			expect(screen.queryByLabelText("Open API History")).not.toBeInTheDocument()
			expect(screen.queryByLabelText("Open UI History")).not.toBeInTheDocument()
		})

		it("sends openDebugApiHistory message when API history button is clicked", () => {
			mockUseExtensionState.mockReturnValue({ debug: true } as any)

			render(<TaskActions item={mockItem} buttonsDisabled={false} />)
			fireEvent.click(screen.getByLabelText("Open API History"))

			expect(mockPostMessage).toHaveBeenCalledWith({ type: "openDebugApiHistory" })
		})

		it("sends openDebugUiHistory message when UI history button is clicked", () => {
			mockUseExtensionState.mockReturnValue({ debug: true } as any)

			render(<TaskActions item={mockItem} buttonsDisabled={false} />)
			fireEvent.click(screen.getByLabelText("Open UI History"))

			expect(mockPostMessage).toHaveBeenCalledWith({ type: "openDebugUiHistory" })
		})
	})
})
