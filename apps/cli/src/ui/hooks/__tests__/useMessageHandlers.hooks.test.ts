import { isHookSayMessage } from "../useMessageHandlers.js"

describe("useMessageHandlers hook compatibility", () => {
	it("suppresses structured hook rows from the TUI message ledger", () => {
		expect(isHookSayMessage("hook")).toBe(true)
		expect(isHookSayMessage("text")).toBe(false)
	})
})
