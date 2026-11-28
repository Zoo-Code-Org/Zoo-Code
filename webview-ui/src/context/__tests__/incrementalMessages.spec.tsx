import { act, render, screen } from "@testing-library/react"
import type { ExtensionMessage } from "@roo-code/types"
import { ExtensionStateContextProvider, useExtensionState } from "../ExtensionStateContext"
import { vscode } from "../../utils/vscode"

function Transcript() {
	const { clineMessages, currentTaskId } = useExtensionState()
	return (
		<div data-testid="transcript">
			{currentTaskId}:{clineMessages.map((message) => message.text).join("|")}
		</div>
	)
}

function receive(message: ExtensionMessage) {
	act(() => window.dispatchEvent(new MessageEvent("message", { data: message })))
}

describe("incremental transcript integration", () => {
	afterEach(() => vi.restoreAllMocks())

	it("negotiates support, appends, recovers a gap and rejects background updates", () => {
		const post = vi.spyOn(vscode, "postMessage")
		render(
			<ExtensionStateContextProvider>
				<Transcript />
			</ExtensionStateContextProvider>,
		)
		expect(post).toHaveBeenCalledWith({ type: "webviewDidLaunch", supportsClineMessagesDelta: true })
		const first = { ts: 1, type: "say" as const, say: "text" as const, text: "first" }
		const second = { ...first, ts: 2, text: "second" }
		receive({ type: "state", state: { currentTaskId: "a", clineMessagesSeq: 1, clineMessages: [first] } })
		receive({
			type: "state",
			state: { currentTaskId: "a", clineMessagesSeq: 2 },
			clineMessagesDelta: {
				taskId: "a",
				baseSeq: 1,
				baseLength: 1,
				length: 2,
				updates: [{ index: 1, message: second }],
			},
		})
		expect(screen.getByTestId("transcript").textContent).toBe("a:first|second")
		receive({ type: "messageUpdated", clineMessageTaskId: "b", clineMessage: { ...first, text: "background" } })
		expect(screen.getByTestId("transcript").textContent).toBe("a:first|second")
		receive({
			type: "state",
			state: { currentTaskId: "a", clineMessagesSeq: 4 },
			clineMessagesDelta: { taskId: "a", baseSeq: 3, baseLength: 2, length: 2, updates: [] },
		})
		expect(post).toHaveBeenCalledWith({ type: "requestClineMessagesSync" })
		expect(screen.getByTestId("transcript").textContent).toBe("a:first|second")
		receive({ type: "state", state: { currentTaskId: "b", clineMessagesSeq: 5, clineMessages: [second] } })
		receive({ type: "state", state: { currentTaskId: "a", clineMessagesSeq: 1, clineMessages: [first] } })
		expect(screen.getByTestId("transcript").textContent).toBe("b:second")
	})
})
