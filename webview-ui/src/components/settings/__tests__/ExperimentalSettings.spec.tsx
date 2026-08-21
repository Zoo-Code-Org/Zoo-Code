import { fireEvent, render, screen } from "@testing-library/react"

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

	it("renders the dynamic thinking effort toggle", () => {
		render(<ExperimentalSettings {...defaultProps} />)

		expect(screen.getByText("settings:experimental.DYNAMIC_THINKING_EFFORT.name")).toBeInTheDocument()
	})

	it("binds the dynamic thinking effort toggle to setExperimentEnabled", () => {
		const setExperimentEnabled = vi.fn()
		render(
			<ExperimentalSettings
				{...defaultProps}
				experiments={{ ...experimentDefault, dynamicThinkingEffort: true }}
				setExperimentEnabled={setExperimentEnabled}
			/>,
		)

		const label = screen.getByText("settings:experimental.DYNAMIC_THINKING_EFFORT.name").closest("label")
		const checkbox = label?.querySelector("input[type='checkbox']")
		expect(checkbox).not.toBeNull()
		expect(checkbox).toBeChecked()

		fireEvent.click(checkbox!)

		expect(setExperimentEnabled).toHaveBeenCalledTimes(1)
		expect(setExperimentEnabled).toHaveBeenCalledWith("dynamicThinkingEffort", false)
	})
})
