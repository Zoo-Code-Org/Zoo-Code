import { render } from "ink-testing-library"

import { createMockClient } from "../../agent/extension-client.js"
import { useMessageHandlers, type UseMessageHandlersReturn } from "../hooks/useMessageHandlers.js"
import { useCLIStore } from "../store.js"

describe("dedicated transcript focus compatibility", () => {
	beforeEach(() => useCLIStore.getState().reset())
	afterEach(() => useCLIStore.getState().reset())

	it("does not consume CLI resume readiness before the historical transcript arrives", () => {
		let handlers: UseMessageHandlersReturn | undefined
		function Harness() {
			handlers = useMessageHandlers({ nonInteractive: false })
			return null
		}
		useCLIStore.getState().setIsResumingTask(true)
		const { unmount } = render(<Harness />)
		try {
			expect(handlers).toBeDefined()
			const before = useCLIStore.getState()
			handlers!.handleExtensionMessage({ type: "clineMessagesFocus", taskId: "task-1", taskInstanceId: "new" })
			expect(useCLIStore.getState()).toBe(before)
			expect(useCLIStore.getState().isResumingTask).toBe(true)
			handlers!.handleExtensionMessage({
				type: "state",
				state: { clineMessages: [{ ts: 1, type: "say", say: "text", text: "Historical first message" }] },
			})
			expect(useCLIStore.getState().messages).toEqual([
				expect.objectContaining({ content: "Historical first message" }),
			])
			expect(useCLIStore.getState().isResumingTask).toBe(false)
		} finally {
			unmount()
		}
	})

	it("does not initialize the noninteractive client or overwrite its legacy transcript", () => {
		const { client } = createMockClient()
		client.handleMessage({ type: "clineMessagesFocus", taskId: "task-1", taskInstanceId: "new" })
		expect(client.isInitialized()).toBe(false)
		client.handleMessage({
			type: "state",
			state: { clineMessages: [{ ts: 1, type: "ask", ask: "tool", partial: false }], mode: "code" },
		})
		expect(client.isWaitingForInput()).toBe(true)
		client.handleMessage({ type: "clineMessagesFocus" })
		expect(client.isWaitingForInput()).toBe(true)
		expect(client.getCurrentMode()).toBe("code")
	})
})
