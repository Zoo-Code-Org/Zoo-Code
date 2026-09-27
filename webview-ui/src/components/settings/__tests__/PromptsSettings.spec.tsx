// npx vitest src/components/settings/__tests__/PromptsSettings.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"

import PromptsSettings from "../PromptsSettings"
import { vscode } from "@src/utils/vscode"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

// Exposed so tests can assert the context (uncontrolled) setter still fires.
const { contextSetIncludeTaskHistoryInEnhance } = vi.hoisted(() => ({
	contextSetIncludeTaskHistoryInEnhance: vi.fn(),
}))

// PromptsSettings falls back to context when props are absent.
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		listApiConfigMeta: [],
		enhancementApiConfigId: "",
		setEnhancementApiConfigId: vi.fn(),
		includeTaskHistoryInEnhance: true,
		setIncludeTaskHistoryInEnhance: contextSetIncludeTaskHistoryInEnhance,
	}),
}))

const renderSettings = (overrides = {}) => {
	const setIncludeTaskHistoryInEnhance = vi.fn()
	const props = {
		customSupportPrompts: {},
		setCustomSupportPrompts: vi.fn(),
		includeTaskHistoryInEnhance: true,
		setIncludeTaskHistoryInEnhance,
		...overrides,
	}
	render(<PromptsSettings {...(props as any)} />)
	return { setIncludeTaskHistoryInEnhance }
}

describe("PromptsSettings - Save/Discard contract", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	// Case 5: includeTaskHistoryInEnhance must buffer, not persist before Save.
	it("buffers includeTaskHistoryInEnhance toggle without persisting before Save", () => {
		const { setIncludeTaskHistoryInEnhance } = renderSettings({ includeTaskHistoryInEnhance: true })

		// The ENHANCE support option is active by default, so the checkbox is present.
		const checkbox = screen
			.getByText("prompts:supportPrompts.enhance.includeTaskHistory")
			.closest("label")!
			.querySelector('input[type="checkbox"]')!
		fireEvent.click(checkbox)

		expect(setIncludeTaskHistoryInEnhance).toHaveBeenCalledWith(false)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))
	})

	// Uncontrolled usage (props omitted) has no cachedState/Save wiring, so the
	// toggle must persist immediately via updateSettings — otherwise it is lost.
	it("persists includeTaskHistoryInEnhance immediately when used uncontrolled", () => {
		render(
			<PromptsSettings
				customSupportPrompts={{}}
				setCustomSupportPrompts={vi.fn()}
				// includeTaskHistoryInEnhance / setIncludeTaskHistoryInEnhance omitted → context fallback
			/>,
		)

		const checkbox = screen
			.getByText("prompts:supportPrompts.enhance.includeTaskHistory")
			.closest("label")!
			.querySelector('input[type="checkbox"]')!
		fireEvent.click(checkbox)

		// Still updates local (context) state, and also persists immediately.
		expect(contextSetIncludeTaskHistoryInEnhance).toHaveBeenCalledWith(false)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: { includeTaskHistoryInEnhance: false },
		})
	})
})
