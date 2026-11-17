import userEvent from "@testing-library/user-event"
import { render, screen, within, waitFor } from "@/utils/test-utils"
import { providerIdentifiers, type ProviderSettings } from "@roo-code/types"

import { ApiConfigSelector } from "../ApiConfigSelector"
import { ProfileQuickSettings } from "../ProfileQuickSettings"
import { setupNativePickerFocus } from "./pickerTestFocus"

setupNativePickerFocus()

const mocks = vi.hoisted(() => ({
	postMessage: vi.fn(),
	configuration: {} as ProviderSettings,
	profileName: "Work",
}))

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: mocks.postMessage } }))
vi.mock("@/components/ui/hooks/useRooPortal", () => ({ useRooPortal: () => document.body }))
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ apiConfiguration: mocks.configuration, currentApiConfigName: mocks.profileName }),
}))
vi.mock("@/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({
		id: mocks.configuration.apiModelId,
		info: {
			contextWindow: 1000,
			supportsPromptCache: false,
			supportsReasoningEffort: ["low", "high"],
			requiredReasoningEffort: true,
		},
	}),
}))
vi.mock("../model-picker/useProfileModelCatalog", () => ({
	useProfileModelCatalog: () => ({
		provider: providerIdentifiers.openaiNative,
		field: "apiModelId",
		models: { "model-a": {}, "model-b": {} },
		isLoading: false,
		isError: false,
		isUnsupported: false,
		refetch: vi.fn(),
	}),
}))

describe("production model picker popover", () => {
	const props = {
		value: "work",
		displayName: "Work",
		modelId: "model-a",
		reasoningEffort: "high",
		title: "Choose profile and model",
		listApiConfigMeta: [
			{ id: "work", name: "Work" },
			{ id: "personal", name: "Personal" },
		],
		onChange: vi.fn(),
		togglePinnedApiConfig: vi.fn(),
		lockApiConfigAcrossModes: false,
		onToggleLockApiConfig: vi.fn(),
	}
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.profileName = "Work"
		mocks.configuration = { apiProvider: providerIdentifiers.openaiNative, apiModelId: "model-a" }
	})

	it("keeps open for model and effort selection, then dismisses on outside click", async () => {
		const user = userEvent.setup()
		const { rerender } = render(
			<>
				<button>Outside</button>
				<ApiConfigSelector {...props} quickSettings={<ProfileQuickSettings />} />
			</>,
		)
		await user.click(screen.getByTestId("dropdown-trigger"))
		const dialog = screen.getByRole("dialog")
		expect(dialog).toHaveClass("max-h-[var(--radix-popover-content-available-height)]", "flex", "overflow-hidden")
		await user.click(within(dialog).getByRole("button", { name: "model-b" }))
		expect(screen.getByRole("dialog")).toBeInTheDocument()
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ type: "updateProfileModel", text: "Work" }),
		)
		expect(within(dialog).getByRole("button", { name: "chat:modelPicker.effort.low" })).toBeDisabled()
		mocks.configuration = { ...mocks.configuration, apiModelId: "model-b" }
		rerender(
			<>
				<button>Outside</button>
				<ApiConfigSelector {...props} quickSettings={<ProfileQuickSettings />} />
			</>,
		)
		await user.click(within(dialog).getByRole("button", { name: "chat:modelPicker.effort.low" }))
		expect(screen.getByRole("dialog")).toBeInTheDocument()
		expect(mocks.postMessage).toHaveBeenLastCalledWith({
			type: "updateProfileModel",
			text: "Work",
			values: {
				expectedProvider: providerIdentifiers.openaiNative,
				patch: { reasoningEffort: "low", enableReasoningEffort: true },
			},
		})
		await user.click(screen.getByRole("button", { name: "Outside" }))
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
	})

	it("waits for the requested active profile id before mounting new model controls", async () => {
		const user = userEvent.setup()
		const { rerender } = render(<ApiConfigSelector {...props} quickSettings={<ProfileQuickSettings />} />)
		await user.click(screen.getByTestId("dropdown-trigger"))
		await user.click(screen.getByRole("button", { name: "chat:modelPicker.selectProfile" }))
		const profiles = screen.getByRole("button", { name: "Personal" }).closest(".h-\\[300px\\]")
		expect(profiles).toHaveClass("h-[300px]", "shrink-0", "overflow-y-auto")
		await user.type(screen.getByRole("textbox"), "zzzzz")
		expect(screen.getByText("common:ui.no_results")).toHaveClass("h-[300px]")
		await user.click(screen.getByRole("button", { name: "chat:modelPicker.clearSearch" }))
		await user.keyboard("{Tab}{End}{Enter}")
		expect(props.onChange).toHaveBeenCalledWith("personal")
		expect(screen.getByRole("dialog")).toBeInTheDocument()
		expect(screen.getByRole("status")).toHaveClass("h-[300px]", "shrink-0", "overflow-y-auto")
		expect(screen.queryByRole("button", { name: "model-b" })).not.toBeInTheDocument()
		// An unrelated active id must not release the stale pane.
		rerender(<ApiConfigSelector {...props} value="other" quickSettings={<ProfileQuickSettings />} />)
		expect(screen.queryByRole("button", { name: "model-b" })).not.toBeInTheDocument()
		await user.keyboard("{Escape}")
		await user.click(screen.getByTestId("dropdown-trigger"))
		expect(screen.getByRole("button", { name: "model-b" })).toBeEnabled()
		mocks.profileName = "Personal"
		rerender(
			<ApiConfigSelector
				{...props}
				value="personal"
				displayName="Personal"
				quickSettings={<ProfileQuickSettings />}
			/>,
		)
		await user.click(screen.getByRole("button", { name: "model-b" }))
		expect(mocks.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ text: "Personal", type: "updateProfileModel" }),
		)
		expect(screen.getByRole("dialog")).toBeInTheDocument()
		await user.keyboard("{Escape}")
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
	})
})
