// npx vitest run src/components/chat/__tests__/ChangeCard.spec.tsx

import React from "react"
import { fireEvent, renderWithExtensionState, screen } from "@/utils/test-utils"
import type { ChangeCardData, ClineMessage } from "@roo-code/types"

const mockPostMessage = vi.fn()

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (...args: unknown[]) => mockPostMessage(...args),
	},
}))

// Mock i18n (same pattern as the other ChatRow specs)
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: { count?: number }) => {
			const map: Record<string, string> = {
				"chat:changeCard.header": `${options?.count ?? 0} file(s) changed this step`,
				"chat:changeCard.rollbackFile": "Rollback this file",
				"chat:changeCard.rollbackStep": "Rollback step",
				"chat:changeCard.rollbackWarning": "Restores the previous content of this step's files.",
				"chat:changeCard.confirm": "Confirm",
				"chat:changeCard.cancel": "Cancel",
				"chat:changeCard.rollingBack": "Rolling back...",
				"chat:changeCard.rolledBack": "Rolled back",
				"chat:changeCard.stepRolledBack": "Step rolled back",
				"chat:changeCard.rollbackFailed": "Rollback failed",
			}
			return map[key] || key
		},
	}),
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

// Mock DiffView so the diff text is directly assertable (the real one runs a
// syntax highlighter, which is irrelevant to the lazy-expansion behavior).
vi.mock("@src/components/common/DiffView", () => ({
	default: ({ source }: { source: string }) => <div data-testid="diff-view">{source}</div>,
}))

import { ChangeCard } from "../ChangeCard"
import { ChatRowContent } from "../ChatRow"

function makeCardMessage(overrides: Partial<ChangeCardData> = {}, ts = 1000): ClineMessage {
	const card: ChangeCardData = {
		checkpointIds: ["abc123"],
		files: [
			{ path: "src/a.ts", additions: 12, deletions: 3 },
			{ path: "src/b.ts", additions: 1, deletions: 1 },
		],
		totalFiles: 2,
		detail: "summary",
		...overrides,
	}
	return {
		type: "say",
		say: "change_card",
		ts,
		partial: false,
		text: JSON.stringify(card),
	}
}

const DIFF_A = "@@ -1,1 +1,2 @@\n-old\n+new-a\n+extra\n"
const DIFF_B = "@@ -1,1 +1,1 @@\n-old\n+new-b\n"

function fireRollbackResult(data: Record<string, unknown>) {
	fireEvent(window, new MessageEvent("message", { data }))
}

describe("ChangeCard", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders the header count and per-file list from a multi-file payload", () => {
		renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		expect(screen.getByTestId("change-card-header")).toHaveTextContent("2 file(s) changed this step")
		expect(screen.getByText((text) => text.includes("src/a.ts"))).toBeInTheDocument()
		expect(screen.getByText((text) => text.includes("src/b.ts"))).toBeInTheDocument()
		expect(screen.getByText("+12")).toBeInTheDocument()
		expect(screen.getByText("-3")).toBeInTheDocument()
		expect(screen.getByText("+1")).toBeInTheDocument()
		expect(screen.getByText("-1")).toBeInTheDocument()
	})

	it("keeps the diff hidden in summary cards until the file row is expanded", () => {
		renderWithExtensionState(
			<ChangeCard
				message={makeCardMessage({
					detail: "summary",
					files: [{ path: "src/a.ts", additions: 1, deletions: 1, diff: DIFF_A }],
					totalFiles: 1,
				})}
			/>,
		)

		// Collapsed by default: the diff text is not rendered.
		expect(screen.queryByTestId("diff-view")).toBeNull()
		expect(screen.queryByText((content) => content.includes("+new-a"))).toBeNull()

		// Expand the file row.
		fireEvent.click(screen.getByText((text) => text.includes("src/a.ts")))

		// The diff text comes from the payload and is rendered lazily on expand.
		expect(screen.getByTestId("diff-view").textContent).toContain(DIFF_A.trim())

		// Collapse again.
		fireEvent.click(screen.getByText((text) => text.includes("src/a.ts")))
		expect(screen.queryByTestId("diff-view")).toBeNull()
	})

	it("renders the diff inline by default in full cards", () => {
		renderWithExtensionState(
			<ChangeCard
				message={makeCardMessage({
					detail: "full",
					files: [
						{ path: "src/a.ts", additions: 1, deletions: 1, diff: DIFF_A },
						{ path: "src/b.ts", additions: 1, deletions: 1, diff: DIFF_B },
					],
					totalFiles: 2,
				})}
			/>,
		)

		const [diffA, diffB] = screen.getAllByTestId("diff-view")
		expect(diffA.textContent).toContain(DIFF_A.trim())
		expect(diffB.textContent).toContain(DIFF_B.trim())
	})

	it("renders compact rows without a diff section when the payload carries no diffs", () => {
		// Auto-approved steps are always emitted as summary cards without any
		// per-file diff field; the card then renders file rows with stats only.
		renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		expect(screen.getByTestId("change-card-header")).toBeInTheDocument()
		expect(screen.queryByTestId("diff-view")).toBeNull()
		expect(screen.getByText((text) => text.includes("src/a.ts"))).toBeInTheDocument()
		expect(screen.getByText((text) => text.includes("src/b.ts"))).toBeInTheDocument()
	})

	it("renders nothing for an unparseable card payload", () => {
		const { container } = renderWithExtensionState(
			<ChangeCard message={{ type: "say", say: "change_card", ts: 1, text: "not-json" } as ClineMessage} />,
		)

		expect(container.innerHTML).toBe("")
	})

	it("rolls back one file through the checkpointRollbackFile message and shows pending + success", async () => {
		renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		// Open the confirm step for the first file.
		fireEvent.click(screen.getByTestId("change-card-file-rollback-0"))
		expect(screen.getByTestId("change-card-file-confirm-0")).toBeInTheDocument()

		// Confirm sends the webview->extension message and goes pending.
		fireEvent.click(screen.getByText("Confirm"))
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "checkpointRollbackFile",
			payload: { cardTs: 1000, checkpointId: "abc123", filePath: "src/a.ts" },
		})
		expect(screen.getByTestId("change-card-file-pending-0")).toBeInTheDocument()

		// The extension ack resolves the pending state.
		fireRollbackResult({
			type: "checkpointRollbackResult",
			checkpointRollbackResult: { cardTs: 1000, filePath: "src/a.ts", success: true },
		})
		await screen.findByTestId("change-card-file-success-0")
		expect(screen.getByTestId("change-card-file-success-0")).toHaveTextContent("Rolled back")
	})

	it("shows the file rollback error state on a failed ack", async () => {
		renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		fireEvent.click(screen.getByTestId("change-card-file-rollback-0"))
		fireEvent.click(screen.getByText("Confirm"))

		fireRollbackResult({
			type: "checkpointRollbackResult",
			checkpointRollbackResult: {
				cardTs: 1000,
				filePath: "src/a.ts",
				success: false,
				error: "checkpoint not found",
			},
		})

		expect(await screen.findByTestId("change-card-file-error-0")).toHaveTextContent("Rollback failed")
	})

	it("rolls back the whole step through the checkpointRollbackStep message and shows pending + success", async () => {
		renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		// Open the confirm step for the step-level rollback.
		fireEvent.click(screen.getByTestId("change-card-step-rollback"))
		expect(screen.getByTestId("change-card-step-confirm")).toBeInTheDocument()
		expect(screen.getByText("Restores the previous content of this step's files.")).toBeInTheDocument()

		// Confirm sends the step message with the step's file list.
		fireEvent.click(screen.getByText("Confirm"))
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "checkpointRollbackStep",
			payload: { cardTs: 1000, checkpointId: "abc123", filePaths: ["src/a.ts", "src/b.ts"] },
		})
		expect(screen.getByTestId("change-card-step-pending")).toBeInTheDocument()

		// The extension ack (per-step result carries the per-file outcomes).
		fireRollbackResult({
			type: "checkpointRollbackResult",
			checkpointRollbackResult: {
				cardTs: 1000,
				success: true,
				files: [
					{ filePath: "src/a.ts", success: true },
					{ filePath: "src/b.ts", success: true },
				],
			},
		})
		expect(await screen.findByTestId("change-card-step-success")).toHaveTextContent("Step rolled back")
		// Per-file rows resolve to success as well.
		expect(screen.getByTestId("change-card-file-success-0")).toBeInTheDocument()
		expect(screen.getByTestId("change-card-file-success-1")).toBeInTheDocument()
	})

	it("shows the step rollback error state with the first failing file's error", async () => {
		renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		fireEvent.click(screen.getByTestId("change-card-step-rollback"))
		fireEvent.click(screen.getByText("Confirm"))

		fireRollbackResult({
			type: "checkpointRollbackResult",
			checkpointRollbackResult: {
				cardTs: 1000,
				success: false,
				files: [
					{ filePath: "src/a.ts", success: true },
					{ filePath: "src/b.ts", success: false, error: "boom" },
				],
			},
		})

		expect(await screen.findByTestId("change-card-step-error")).toHaveTextContent("Rollback failed")
		expect(screen.getByTestId("change-card-file-error-1")).toBeInTheDocument()
		expect(screen.getByTestId("change-card-file-success-0")).toBeInTheDocument()
	})

	it("resolves the step state from a failure result that carries no files", async () => {
		// The missing-task response is a step-level result with success: false
		// and no per-file payload (no files, no filePath). Without handling the
		// empty shape the step button would stay in the pending state forever.
		renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		fireEvent.click(screen.getByTestId("change-card-step-rollback"))
		fireEvent.click(screen.getByText("Confirm"))
		expect(screen.getByTestId("change-card-step-pending")).toBeInTheDocument()

		fireRollbackResult({
			type: "checkpointRollbackResult",
			checkpointRollbackResult: {
				cardTs: 1000,
				success: false,
				error: "Checkpoints are not enabled for this task",
			},
		})

		// The error detail rides in the tooltip content; the visible state is
		// the rollback-failed label. The assertion that matters here is that the
		// step left the pending state at all (previously it would stay pending).
		expect(await screen.findByTestId("change-card-step-error")).toHaveTextContent("Rollback failed")
	})

	it("keeps the step in the pending state until a no-files success resolves it", async () => {
		renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		fireEvent.click(screen.getByTestId("change-card-step-rollback"))
		fireEvent.click(screen.getByText("Confirm"))
		expect(screen.getByTestId("change-card-step-pending")).toBeInTheDocument()

		fireRollbackResult({
			type: "checkpointRollbackResult",
			checkpointRollbackResult: { cardTs: 1000, success: true },
		})

		expect(await screen.findByTestId("change-card-step-success")).toBeInTheDocument()
	})

	it("ignores rollback results for other change cards", () => {
		renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		// Unrelated extension messages are dropped by the card's listener.
		fireEvent(window, new MessageEvent("message", { data: { type: "state", text: "x" } }))

		fireEvent.click(screen.getByTestId("change-card-step-rollback"))
		fireEvent.click(screen.getByText("Confirm"))
		expect(screen.getByTestId("change-card-step-pending")).toBeInTheDocument()

		// A result for a different card ts must not resolve this card.
		fireRollbackResult({
			type: "checkpointRollbackResult",
			checkpointRollbackResult: { cardTs: 999, success: true, files: [] },
		})

		expect(screen.getByTestId("change-card-step-pending")).toBeInTheDocument()
	})

	it("cancels the file and step rollback confirmations without sending a message", () => {
		renderWithExtensionState(<ChangeCard message={makeCardMessage()} />)

		// File-level cancel returns to idle without a rollback message.
		fireEvent.click(screen.getByTestId("change-card-file-rollback-0"))
		fireEvent.click(screen.getByTestId("change-card-file-cancel-0"))
		expect(screen.getByTestId("change-card-file-rollback-0")).toBeInTheDocument()
		expect(mockPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "checkpointRollbackFile" }))

		// Step-level cancel returns to idle as well.
		fireEvent.click(screen.getByTestId("change-card-step-rollback"))
		fireEvent.click(screen.getByTestId("change-card-step-cancel"))
		expect(screen.getByTestId("change-card-step-rollback")).toBeInTheDocument()
		expect(mockPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "checkpointRollbackStep" }))
	})
})

describe("ChatRow - change_card say", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders the change card for change_card messages", () => {
		renderWithExtensionState(
			<ChatRowContent
				message={makeCardMessage()}
				isExpanded={false}
				isLast={false}
				isStreaming={false}
				onToggleExpand={() => {}}
				onSuggestionClick={() => {}}
				onBatchFileResponse={() => {}}
				onFollowUpUnmount={() => {}}
				isFollowUpAnswered={false}
			/>,
		)

		expect(screen.getByTestId("change-card-header")).toHaveTextContent("2 file(s) changed this step")
	})
})
