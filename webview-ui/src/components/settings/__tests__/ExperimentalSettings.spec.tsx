import { render, screen } from "@testing-library/react"

import { experimentDefault } from "@roo/experiments"

import { ExperimentalSettings } from "../ExperimentalSettings"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

describe("ExperimentalSettings", () => {
	const defaultProps = {
		experiments: experimentDefault,
		setExperimentEnabled: vi.fn(),
		setImageGenerationProvider: vi.fn(),
		setOpenRouterImageApiKey: vi.fn(),
		setImageGenerationSelectedModel: vi.fn(),
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("does not render internal-only experiment flags", () => {
		render(<ExperimentalSettings {...defaultProps} />)

		expect(screen.getByText("settings:experimental.PREVENT_FOCUS_DISRUPTION.name")).toBeInTheDocument()
		expect(screen.getByText("settings:experimental.RUN_SLASH_COMMAND.name")).toBeInTheDocument()
		expect(screen.getByText("settings:experimental.IMAGE_GENERATION.name")).toBeInTheDocument()
		expect(screen.getByText("settings:experimental.CUSTOM_TOOLS.name")).toBeInTheDocument()
		expect(screen.queryByText("settings:experimental.PARALLEL_TOOL_EXECUTION.name")).not.toBeInTheDocument()
	})

	it("hides the dynamic thinking effort toggle until the set_thinking_effort tool is registered", () => {
		// The flag persists and round-trips, but the tool is not in getNativeTools()
		// yet, so the toggle must not render - not even when the flag is enabled.
		const { unmount } = render(
			<ExperimentalSettings
				{...defaultProps}
				experiments={{ ...experimentDefault, dynamicThinkingEffort: true }}
			/>,
		)
		expect(screen.queryByText("settings:experimental.DYNAMIC_THINKING_EFFORT.name")).not.toBeInTheDocument()
		unmount()

		render(<ExperimentalSettings {...defaultProps} />)
		expect(screen.queryByText("settings:experimental.DYNAMIC_THINKING_EFFORT.name")).not.toBeInTheDocument()
	})
})
