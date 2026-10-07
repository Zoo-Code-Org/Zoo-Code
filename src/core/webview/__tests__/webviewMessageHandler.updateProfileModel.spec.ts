// npx vitest run core/webview/__tests__/webviewMessageHandler.updateProfileModel.spec.ts

import { providerIdentifiers } from "@roo-code/types"

import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ClineProvider } from "../ClineProvider"

describe("webviewMessageHandler - updateProfileModel", () => {
	let mockProvider: { updateProfileModel: ReturnType<typeof vi.fn> }

	const send = (values: Record<string, unknown> | undefined, text: string = "default") =>
		webviewMessageHandler(mockProvider as unknown as ClineProvider, { type: "updateProfileModel", text, values })

	beforeEach(() => {
		vi.clearAllMocks()
		mockProvider = { updateProfileModel: vi.fn().mockResolvedValue(undefined) }
	})

	it("delegates the profile name, expected provider and patch to the provider", async () => {
		const patch = { apiModelId: "claude-3-5-haiku", reasoningEffort: null }

		await send({ expectedProvider: providerIdentifiers.anthropic, patch })

		expect(mockProvider.updateProfileModel).toHaveBeenCalledTimes(1)
		expect(mockProvider.updateProfileModel).toHaveBeenCalledWith("default", providerIdentifiers.anthropic, patch)
	})

	it.each([
		["missing profile name", { expectedProvider: providerIdentifiers.anthropic, patch: {} }, ""],
		["missing values", undefined, "default"],
		["missing expectedProvider", { patch: { apiModelId: "x" } }, "default"],
		["non-string expectedProvider", { expectedProvider: 1, patch: { apiModelId: "x" } }, "default"],
		["missing patch", { expectedProvider: providerIdentifiers.anthropic }, "default"],
		["null patch", { expectedProvider: providerIdentifiers.anthropic, patch: null }, "default"],
		["non-object patch", { expectedProvider: providerIdentifiers.anthropic, patch: "x" }, "default"],
	])("does nothing for %s", async (_label, values, text) => {
		await send(values, text)

		expect(mockProvider.updateProfileModel).not.toHaveBeenCalled()
	})
})
