import { act, renderHook } from "@testing-library/react"
import { providerIdentifiers, type ProviderName } from "@roo-code/types"

import { vscode } from "@/utils/vscode"
import { useModelPickerSubmit } from "../useModelPickerSubmit"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

describe("useModelPickerSubmit", () => {
	beforeEach(() => vi.clearAllMocks())

	it.each([
		{ name: "disabled", profile: "Work", provider: providerIdentifiers.openaiNative, disabled: true },
		{ name: "missing name", profile: undefined, provider: providerIdentifiers.openaiNative, disabled: false },
		{ name: "empty name", profile: "", provider: providerIdentifiers.openaiNative, disabled: false },
		{ name: "missing provider", profile: "Work", provider: undefined, disabled: false },
	])("does not send for $name", ({ profile, provider, disabled }) => {
		const { result } = renderHook(() => useModelPickerSubmit(profile, provider, disabled))
		act(() => result.current({ apiModelId: "new-model" }))
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("sends the exact partial patch to the current profile and provider after rerender", () => {
		const initialProps: { name: string; provider: ProviderName; disabled: boolean } = {
			name: "Work",
			provider: providerIdentifiers.openaiNative,
			disabled: true,
		}
		const { result, rerender } = renderHook(
			({ name, provider, disabled }) => useModelPickerSubmit(name, provider, disabled),
			{ initialProps },
		)
		rerender({ name: "Personal", provider: providerIdentifiers.openai, disabled: false })
		const patch = { openAiModelId: "personal-model", enableReasoningEffort: null }
		act(() => result.current(patch))
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateProfileModel",
			text: "Personal",
			values: { expectedProvider: providerIdentifiers.openai, patch },
		})
	})
})
