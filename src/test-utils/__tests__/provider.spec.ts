import { ClineProviderFactory } from "../../core/webview/ClineProviderFactory"
import { makeClineProviderFactory } from "../provider"

vi.mock("../../activate/registerCommands", () => ({ openClineInNewTab: vi.fn() }))

describe("provider test utilities", () => {
	it("returns independent factory instances and fails on unexpected tab creation", async () => {
		const first = makeClineProviderFactory()
		const second = makeClineProviderFactory()
		expect(first).toBeInstanceOf(ClineProviderFactory)
		expect(second).toBeInstanceOf(ClineProviderFactory)
		expect(second).not.toBe(first)
		expect(first.createInNewTab).not.toBe(second.createInNewTab)
		await expect(first.createInNewTab()).rejects.toThrow("Unexpected editor-tab creation in this test")
		expect(second.createInNewTab).not.toHaveBeenCalled()
	})
})
