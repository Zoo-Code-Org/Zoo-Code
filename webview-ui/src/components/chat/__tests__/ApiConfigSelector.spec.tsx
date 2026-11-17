import { render, screen, fireEvent, waitFor } from "@/utils/test-utils"
import { vscode } from "@/utils/vscode"
import { providerIdentifiers } from "@roo-code/types"

import { ApiConfigSelector } from "../ApiConfigSelector"
import type { ComponentProps, PropsWithChildren } from "react"

// Mock the dependencies
vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("@/components/ui/hooks/useRooPortal", () => ({
	useRooPortal: () => document.body,
}))

// Mock the ExtensionStateContext
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		apiConfiguration: {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-3-opus-20240229",
		},
	}),
}))

// Mock Popover components to be testable
vi.mock("@/components/ui", () => ({
	Popover: ({
		children,
		open,
		onOpenChange,
	}: {
		children: React.ReactNode
		open: boolean
		onOpenChange: (open: boolean) => void
	}) => (
		<div data-testid="popover-root" data-open={open}>
			<button data-testid="toggle-popover" onClick={() => onOpenChange(!open)}>
				Toggle popover
			</button>
			{children}
		</div>
	),
	PopoverTrigger: ({ children, disabled, ...props }: ComponentProps<"button">) => (
		<button data-testid="dropdown-trigger" disabled={disabled} {...props}>
			{children}
		</button>
	),
	PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	PopoverContent: ({ children }: PropsWithChildren) => <div data-testid="popover-content">{children}</div>,
	StandardTooltip: ({ children }: PropsWithChildren) => <>{children}</>,
	Button: ({ children, onClick, ...props }: ComponentProps<"button">) => (
		<button onClick={onClick} {...props}>
			{children}
		</button>
	),
}))

describe("ApiConfigSelector", () => {
	const mockOnChange = vi.fn()
	const mockTogglePinnedApiConfig = vi.fn()

	const defaultProps = {
		value: "config1",
		displayName: "Config 1",
		title: "API Config",
		onChange: mockOnChange,
		listApiConfigMeta: [
			{ id: "config1", name: "Config 1", modelId: "claude-3-opus-20240229" },
			{ id: "config2", name: "Config 2", modelId: "gpt-4" },
			{ id: "config3", name: "Config 3", modelId: "claude-3-sonnet-20240229" },
		],
		pinnedApiConfigs: { config1: true },
		togglePinnedApiConfig: mockTogglePinnedApiConfig,
		lockApiConfigAcrossModes: false,
		onToggleLockApiConfig: vi.fn(),
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	test("renders correctly with default props", () => {
		render(<ApiConfigSelector {...defaultProps} />)

		const trigger = screen.getByTestId("dropdown-trigger")
		expect(trigger).toBeInTheDocument()
		expect(trigger).toHaveTextContent("Config 1")
	})

	test("shows models by default and temporarily replaces them with profiles", () => {
		const { rerender } = render(
			<ApiConfigSelector {...defaultProps} quickSettings={<div>Model settings panel</div>} />,
		)
		fireEvent.click(screen.getByTestId("toggle-popover"))
		expect(screen.getByText("Model settings panel")).toBeInTheDocument()
		expect(screen.getByText("Config 2")).not.toBeVisible()
		fireEvent.click(screen.getByRole("button", { name: "chat:modelPicker.selectProfile" }))
		expect(screen.queryByText("Model settings panel")).not.toBeInTheDocument()
		fireEvent.mouseEnter(screen.getByText("Config 2"))
		expect(mockOnChange).not.toHaveBeenCalled()
		fireEvent.click(screen.getByText("Config 2"))
		expect(mockOnChange).toHaveBeenCalledWith("config2")
		expect(screen.getByText("chat:modelPicker.loadingProfile")).toBeInTheDocument()
		expect(screen.getByTestId("popover-root")).toHaveAttribute("data-open", "true")
		rerender(
			<ApiConfigSelector
				{...defaultProps}
				value="config2"
				displayName="Config 2"
				quickSettings={<div>New profile models</div>}
			/>,
		)
		expect(screen.getByText("New profile models")).toBeInTheDocument()
		expect(screen.queryByText("chat:modelPicker.loadingProfile")).not.toBeInTheDocument()
	})

	test("recovers a rejected profile switch by closing and reopening without exposing stale settings", () => {
		render(<ApiConfigSelector {...defaultProps} quickSettings={<button>Old model settings</button>} />)
		fireEvent.click(screen.getByTestId("toggle-popover"))
		fireEvent.click(screen.getByRole("button", { name: "chat:modelPicker.selectProfile" }))
		fireEvent.click(screen.getByText("Config 2"))
		expect(screen.getByText("chat:modelPicker.loadingProfile")).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Old model settings" })).not.toBeInTheDocument()
		fireEvent.click(screen.getByTestId("toggle-popover"))
		fireEvent.click(screen.getByTestId("toggle-popover"))
		expect(screen.queryByText("chat:modelPicker.loadingProfile")).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Old model settings" })).toBeEnabled()
	})

	test("can return from profile selection without changing the active profile", () => {
		render(<ApiConfigSelector {...defaultProps} quickSettings={<div>Model settings panel</div>} />)
		const header = screen.getByRole("button", { name: "chat:modelPicker.selectProfile" })
		fireEvent.click(header)
		fireEvent.click(header)
		expect(screen.getByText("Model settings panel")).toBeInTheDocument()
		expect(mockOnChange).not.toHaveBeenCalled()
	})

	test("reselects the active profile without waiting for a host update", () => {
		render(<ApiConfigSelector {...defaultProps} quickSettings={<button>Model settings</button>} />)
		fireEvent.click(screen.getByTestId("toggle-popover"))
		fireEvent.click(screen.getByRole("button", { name: "chat:modelPicker.selectProfile" }))
		fireEvent.click(screen.getByRole("button", { name: "Config 1 claude-3-opus-20240229" }))
		expect(mockOnChange).toHaveBeenCalledTimes(1)
		expect(mockOnChange).toHaveBeenCalledWith("config1")
		expect(screen.getByRole("button", { name: "Model settings" })).toBeEnabled()
		expect(screen.queryByText("chat:modelPicker.loadingProfile")).not.toBeInTheDocument()
		expect(screen.getByTestId("popover-root")).toHaveAttribute("data-open", "true")
	})

	test("renders and invokes the locked profile control", () => {
		render(<ApiConfigSelector {...defaultProps} lockApiConfigAcrossModes />)
		const unlock = screen.getByRole("button", { name: "chat:unlockApiConfigAcrossModes" })
		expect(unlock).toHaveClass("text-vscode-focusBorder")
		expect(unlock.querySelector(".codicon-lock")).toBeInTheDocument()
		fireEvent.click(unlock)
		expect(defaultProps.onToggleLockApiConfig).toHaveBeenCalledTimes(1)
	})

	test("keeps the picker open after interacting with model settings", () => {
		render(<ApiConfigSelector {...defaultProps} quickSettings={<button>Choose model</button>} />)
		fireEvent.click(screen.getByTestId("toggle-popover"))
		expect(screen.getByTestId("popover-root")).toHaveAttribute("data-open", "true")
		fireEvent.click(screen.getByRole("button", { name: "Choose model" }))
		expect(screen.getByTestId("popover-root")).toHaveAttribute("data-open", "true")
	})

	test("keeps profile search available for a short profile list in the combined picker", () => {
		render(<ApiConfigSelector {...defaultProps} quickSettings={<div>Model settings panel</div>} />)
		fireEvent.click(screen.getByRole("button", { name: "chat:modelPicker.selectProfile" }))
		const input = screen.getByRole("textbox")
		expect(input.parentElement?.parentElement).toHaveClass("px-3", "py-2")
		const focus = vi.fn()
		input.focus = focus
		fireEvent.change(input, { target: { value: "Config 2" } })
		fireEvent.click(screen.getByRole("button", { name: "chat:modelPicker.clearSearch" }))
		expect(input).toHaveValue("")
		expect(focus).toHaveBeenCalled()
	})

	test("shows profile / model and the reasoning badge on the existing trigger", () => {
		render(<ApiConfigSelector {...defaultProps} modelId="gpt-6.1-sol" reasoningEffort="high" />)
		const trigger = screen.getByTestId("dropdown-trigger")
		expect(trigger).toHaveTextContent("Config 1 / gpt-6.1-sol")
		expect(trigger.querySelector('[aria-label="chat:modelPicker.reasoningEffortValue"]')).toHaveTextContent(
			"chat:modelPicker.effort.high",
		)
		fireEvent.click(screen.getByText("Config 2"))
		expect(mockOnChange).toHaveBeenCalledWith("config2")
	})

	test.each([undefined, "disable"])("hides the badge when effort is %s", (reasoningEffort) => {
		render(<ApiConfigSelector {...defaultProps} modelId="gpt-6.1-sol" reasoningEffort={reasoningEffort} />)
		expect(
			screen
				.getByTestId("dropdown-trigger")
				.querySelector('[aria-label="chat:modelPicker.reasoningEffortValue"]'),
		).toBeNull()
	})

	test("keeps none visible as a valid reasoning effort", () => {
		render(<ApiConfigSelector {...defaultProps} modelId="gpt-6.1-sol" reasoningEffort="none" />)
		expect(screen.getByLabelText("chat:modelPicker.reasoningEffortValue")).toBeInTheDocument()
	})

	test("handles disabled state correctly", () => {
		render(<ApiConfigSelector {...defaultProps} disabled={true} />)

		const trigger = screen.getByTestId("dropdown-trigger")
		expect(trigger).toBeDisabled()
	})

	test("renders with custom title tooltip", () => {
		const customTitle = "Custom tooltip text"
		render(<ApiConfigSelector {...defaultProps} title={customTitle} />)

		// The component should render with the tooltip wrapper
		const trigger = screen.getByTestId("dropdown-trigger")
		expect(trigger).toBeInTheDocument()
	})

	test("applies custom trigger className", () => {
		const customClass = "custom-trigger-class"
		render(<ApiConfigSelector {...defaultProps} triggerClassName={customClass} />)

		const trigger = screen.getByTestId("dropdown-trigger")
		expect(trigger.className).toContain(customClass)
	})

	test("opens popover when trigger is clicked", () => {
		render(<ApiConfigSelector {...defaultProps} />)

		const trigger = screen.getByTestId("dropdown-trigger")
		fireEvent.click(trigger)

		// Check if popover content is rendered
		const popoverContent = screen.getByTestId("popover-content")
		expect(popoverContent).toBeInTheDocument()
	})

	test("renders search input when popover is open and more than 6 configs", () => {
		const props = {
			...defaultProps,
			listApiConfigMeta: [
				{ id: "config1", name: "Config 1", modelId: "claude-3-opus-20240229" },
				{ id: "config2", name: "Config 2", modelId: "gpt-4" },
				{ id: "config3", name: "Config 3", modelId: "claude-3-sonnet-20240229" },
				{ id: "config4", name: "Config 4", modelId: "gpt-3.5-turbo" },
				{ id: "config5", name: "Config 5", modelId: "claude-3-haiku-20240307" },
				{ id: "config6", name: "Config 6", modelId: "gpt-4-turbo" },
				{ id: "config7", name: "Config 7", modelId: "claude-2.1" },
			],
		}
		render(<ApiConfigSelector {...props} />)

		const trigger = screen.getByTestId("dropdown-trigger")
		fireEvent.click(trigger)

		const searchInput = screen.getByPlaceholderText("common:ui.search_placeholder")
		expect(searchInput).toBeInTheDocument()
	})

	test("renders info blurb instead of search when 6 or fewer configs", () => {
		render(<ApiConfigSelector {...defaultProps} />)

		const trigger = screen.getByTestId("dropdown-trigger")
		fireEvent.click(trigger)

		// Should not have search input
		expect(screen.queryByPlaceholderText("common:ui.search_placeholder")).not.toBeInTheDocument()
		// Should have info blurb
		expect(screen.getByText("prompts:apiConfiguration.select")).toBeInTheDocument()
	})

	test("filters configs based on search input", async () => {
		const props = {
			...defaultProps,
			listApiConfigMeta: [
				{ id: "config1", name: "Config 1", modelId: "claude-3-opus-20240229" },
				{ id: "config2", name: "Config 2", modelId: "gpt-4" },
				{ id: "config3", name: "Config 3", modelId: "claude-3-sonnet-20240229" },
				{ id: "config4", name: "Config 4", modelId: "gpt-3.5-turbo" },
				{ id: "config5", name: "Config 5", modelId: "claude-3-haiku-20240307" },
				{ id: "config6", name: "Config 6", modelId: "gpt-4-turbo" },
				{ id: "config7", name: "Config 7", modelId: "claude-2.1" },
			],
		}
		render(<ApiConfigSelector {...props} />)

		const trigger = screen.getByTestId("dropdown-trigger")
		fireEvent.click(trigger)

		const searchInput = screen.getByPlaceholderText("common:ui.search_placeholder")
		fireEvent.change(searchInput, { target: { value: "Config 2" } })

		// Wait for the filtering to take effect
		await waitFor(() => {
			// Config 2 should be visible
			expect(screen.getByText("Config 2")).toBeInTheDocument()
			// Config 3 should not be visible (assuming exact match filtering)
			expect(screen.queryByText("Config 3")).not.toBeInTheDocument()
		})
	})

	test("shows no results message when search has no matches", async () => {
		const props = {
			...defaultProps,
			listApiConfigMeta: [
				{ id: "config1", name: "Config 1", modelId: "claude-3-opus-20240229" },
				{ id: "config2", name: "Config 2", modelId: "gpt-4" },
				{ id: "config3", name: "Config 3", modelId: "claude-3-sonnet-20240229" },
				{ id: "config4", name: "Config 4", modelId: "gpt-3.5-turbo" },
				{ id: "config5", name: "Config 5", modelId: "claude-3-haiku-20240307" },
				{ id: "config6", name: "Config 6", modelId: "gpt-4-turbo" },
				{ id: "config7", name: "Config 7", modelId: "claude-2.1" },
			],
		}
		render(<ApiConfigSelector {...props} />)

		const trigger = screen.getByTestId("dropdown-trigger")
		fireEvent.click(trigger)

		const searchInput = screen.getByPlaceholderText("common:ui.search_placeholder")
		fireEvent.change(searchInput, { target: { value: "NonExistentConfig" } })

		await waitFor(() => {
			expect(screen.getByText("common:ui.no_results")).toBeInTheDocument()
		})
	})

	test("clears search when X button is clicked", async () => {
		const props = {
			...defaultProps,
			listApiConfigMeta: [
				{ id: "config1", name: "Config 1", modelId: "claude-3-opus-20240229" },
				{ id: "config2", name: "Config 2", modelId: "gpt-4" },
				{ id: "config3", name: "Config 3", modelId: "claude-3-sonnet-20240229" },
				{ id: "config4", name: "Config 4", modelId: "gpt-3.5-turbo" },
				{ id: "config5", name: "Config 5", modelId: "claude-3-haiku-20240307" },
				{ id: "config6", name: "Config 6", modelId: "gpt-4-turbo" },
				{ id: "config7", name: "Config 7", modelId: "claude-2.1" },
			],
		}
		render(<ApiConfigSelector {...props} />)

		const trigger = screen.getByTestId("dropdown-trigger")
		fireEvent.click(trigger)

		const searchInput = screen.getByPlaceholderText("common:ui.search_placeholder") as HTMLInputElement
		fireEvent.change(searchInput, { target: { value: "test" } })

		expect(searchInput.value).toBe("test")

		// Find and click the X button
		const clearButton = screen.getByTestId("popover-content").querySelector(".cursor-pointer")
		if (clearButton) {
			fireEvent.click(clearButton)
		}

		await waitFor(() => {
			expect(searchInput.value).toBe("")
		})
	})

	test("calls onChange when a config is selected", () => {
		render(<ApiConfigSelector {...defaultProps} />)

		const trigger = screen.getByTestId("dropdown-trigger")
		fireEvent.click(trigger)

		const config2 = screen.getByText("Config 2")
		fireEvent.click(config2)

		expect(mockOnChange).toHaveBeenCalledWith("config2")
	})

	test("shows check mark for selected config", () => {
		render(<ApiConfigSelector {...defaultProps} />)

		const trigger = screen.getByTestId("dropdown-trigger")
		fireEvent.click(trigger)

		// The selected config (config1) should have a check mark
		// Use getAllByText since there might be multiple elements with "Config 1"
		const config1Elements = screen.getAllByText("Config 1")
		// Find the one that's in the dropdown content (not the trigger)
		const configInDropdown = config1Elements.find((el) => el.closest('[data-testid="popover-content"]'))
		// Navigate up to find the parent row that contains both the text and the check icon
		const selectedConfigRow = configInDropdown?.closest(".group")
		const checkIcon = selectedConfigRow?.querySelector(".codicon-check")
		expect(checkIcon).toBeInTheDocument()
	})

	test("separates pinned and unpinned configs", () => {
		const props = {
			...defaultProps,
			pinnedApiConfigs: { config1: true, config3: true },
		}

		render(<ApiConfigSelector {...props} />)

		const trigger = screen.getByTestId("dropdown-trigger")
		fireEvent.click(trigger)

		const content = screen.getByTestId("popover-content")
		// Get all config items by looking for the group class
		const configRows = content.querySelectorAll(".group")

		// Extract the config names from each row
		const configNames: string[] = []
		configRows.forEach((row) => {
			// Find the first span that's flex-shrink-0 (the profile name)
			const nameElement = row.querySelector(".flex-1 span.flex-shrink-0")
			if (nameElement?.textContent) {
				configNames.push(nameElement.textContent)
			}
		})

		// Pinned configs should appear first
		expect(configNames[0]).toBe("Config 1")
		expect(configNames[1]).toBe("Config 3")
		// Unpinned config should appear after separator
		expect(configNames[2]).toBe("Config 2")
	})

	test("toggles pin status when pin button is clicked", () => {
		render(<ApiConfigSelector {...defaultProps} />)

		const trigger = screen.getByTestId("dropdown-trigger")
		fireEvent.click(trigger)

		// Find the pin button for Config 2 (unpinned)
		const config2Row = screen.getByText("Config 2").closest(".group")
		// Find the button with the pin icon (it's the second button, first is the row itself)
		const buttons = config2Row?.querySelectorAll("button")
		const pinButton = Array.from(buttons || []).find((btn) => btn.querySelector(".codicon-pin"))

		if (pinButton) {
			fireEvent.click(pinButton)
		}

		expect(mockTogglePinnedApiConfig).toHaveBeenCalledWith("config2")
		expect(vi.mocked(vscode.postMessage)).toHaveBeenCalledWith({
			type: "toggleApiConfigPin",
			text: "config2",
		})
	})

	test("opens settings when edit button is clicked", () => {
		render(<ApiConfigSelector {...defaultProps} />)

		const trigger = screen.getByTestId("dropdown-trigger")
		fireEvent.click(trigger)

		// Find the settings button by its icon class within the popover content
		const popoverContent = screen.getByTestId("popover-content")
		const settingsButton = popoverContent.querySelector('[aria-label="chat:edit"]') as HTMLElement
		expect(settingsButton).toBeInTheDocument()
		fireEvent.click(settingsButton)

		expect(vi.mocked(vscode.postMessage)).toHaveBeenCalledWith({
			type: "switchTab",
			tab: "settings",
		})
	})

	test("renders bottom bar with title and info icon when more than 6 configs", () => {
		const props = {
			...defaultProps,
			listApiConfigMeta: [
				{ id: "config1", name: "Config 1", modelId: "claude-3-opus-20240229" },
				{ id: "config2", name: "Config 2", modelId: "gpt-4" },
				{ id: "config3", name: "Config 3", modelId: "claude-3-sonnet-20240229" },
				{ id: "config4", name: "Config 4", modelId: "gpt-3.5-turbo" },
				{ id: "config5", name: "Config 5", modelId: "claude-3-haiku-20240307" },
				{ id: "config6", name: "Config 6", modelId: "gpt-4-turbo" },
				{ id: "config7", name: "Config 7", modelId: "claude-2.1" },
			],
		}
		render(<ApiConfigSelector {...props} />)

		const trigger = screen.getByTestId("dropdown-trigger")
		fireEvent.click(trigger)

		// Check for the title
		expect(screen.getByText("prompts:apiConfiguration.title")).toBeInTheDocument()

		// Check for the info icon
		const infoIcon = screen.getByTestId("popover-content").querySelector(".codicon-info")
		expect(infoIcon).toBeInTheDocument()
	})

	test("renders bottom bar with title but no info icon when 6 or fewer configs", () => {
		render(<ApiConfigSelector {...defaultProps} />)

		const trigger = screen.getByTestId("dropdown-trigger")
		fireEvent.click(trigger)

		// Check for the title
		expect(screen.getByText("prompts:apiConfiguration.title")).toBeInTheDocument()

		// Check that info icon is not present
		const infoIcon = screen.getByTestId("popover-content").querySelector(".codicon-info")
		expect(infoIcon).not.toBeInTheDocument()
	})

	test("handles empty config list gracefully", () => {
		const props = {
			...defaultProps,
			listApiConfigMeta: [],
		}

		render(<ApiConfigSelector {...props} />)

		const trigger = screen.getByTestId("dropdown-trigger")
		fireEvent.click(trigger)

		// Should render info blurb instead of search for empty list
		expect(screen.queryByPlaceholderText("common:ui.search_placeholder")).not.toBeInTheDocument()
		expect(screen.getByText("prompts:apiConfiguration.select")).toBeInTheDocument()
		expect(screen.getByText("prompts:apiConfiguration.title")).toBeInTheDocument()
	})

	test("maintains search value when pinning/unpinning", async () => {
		const props = {
			...defaultProps,
			listApiConfigMeta: [
				{ id: "config1", name: "Config 1", modelId: "claude-3-opus-20240229" },
				{ id: "config2", name: "Config 2", modelId: "gpt-4" },
				{ id: "config3", name: "Config 3", modelId: "claude-3-sonnet-20240229" },
				{ id: "config4", name: "Config 4", modelId: "gpt-3.5-turbo" },
				{ id: "config5", name: "Config 5", modelId: "claude-3-haiku-20240307" },
				{ id: "config6", name: "Config 6", modelId: "gpt-4-turbo" },
				{ id: "config7", name: "Config 7", modelId: "claude-2.1" },
			],
		}
		render(<ApiConfigSelector {...props} />)

		const trigger = screen.getByTestId("dropdown-trigger")
		fireEvent.click(trigger)

		const searchInput = screen.getByPlaceholderText("common:ui.search_placeholder") as HTMLInputElement
		fireEvent.change(searchInput, { target: { value: "Config" } })

		// Pin a config
		const config2Row = screen.getByText("Config 2").closest("button")?.parentElement
		const pinButton = config2Row?.querySelector('button[aria-label="chat:pin"]')
		if (pinButton) {
			fireEvent.click(pinButton)
		}

		// Search value should be maintained
		expect(searchInput.value).toBe("Config")
	})

	test("pinned configs remain fixed at top while unpinned configs scroll", () => {
		// Create a list with many configs to test scrolling
		const manyConfigs = Array.from({ length: 15 }, (_, i) => ({
			id: `config${i + 1}`,
			name: `Config ${i + 1}`,
			modelId: `model-${i + 1}`,
		}))

		const props = {
			...defaultProps,
			listApiConfigMeta: manyConfigs,
			pinnedApiConfigs: {
				config1: true,
				config2: true,
				config3: true,
			},
		}

		render(<ApiConfigSelector {...props} />)

		const trigger = screen.getByTestId("dropdown-trigger")
		fireEvent.click(trigger)

		const popoverContent = screen.getByTestId("popover-content")

		// Results keep a fixed height regardless of result count.
		const scrollContainer = popoverContent.querySelector(".h-\\[300px\\].overflow-y-auto")
		expect(scrollContainer).toBeInTheDocument()

		// Check for pinned configs sticky header
		const pinnedStickyHeader = scrollContainer?.querySelector(".sticky.top-0.z-10.bg-vscode-dropdown-background")
		expect(pinnedStickyHeader).toBeInTheDocument()
		expect(pinnedStickyHeader).toHaveAttribute("aria-label", "Pinned configurations")

		// Check for Config 1, 2, 3 being visible in the sticky header (pinned)
		expect(screen.getAllByText("Config 1").length).toBeGreaterThan(0)
		expect(screen.getAllByText("Config 2").length).toBeGreaterThan(0)
		expect(screen.getAllByText("Config 3").length).toBeGreaterThan(0)

		// Verify pinned container contains the pinned configs
		if (pinnedStickyHeader) {
			const elements = pinnedStickyHeader.querySelectorAll(".flex-shrink-0")
			const pinnedConfigTexts = Array.from(elements)
				.map((el) => (el as Element).textContent)
				.filter((text) => text?.startsWith("Config"))

			expect(pinnedConfigTexts).toContain("Config 1")
			expect(pinnedConfigTexts).toContain("Config 2")
			expect(pinnedConfigTexts).toContain("Config 3")
		}

		// Check for unpinned configs section
		const unpinnedSection = scrollContainer?.querySelector('[aria-label="All configurations"]')
		expect(unpinnedSection).toBeInTheDocument()

		// Verify separator exists as border on pinned section when unpinned configs exist
		expect(pinnedStickyHeader).toHaveClass("border-b")
	})

	test("displays all configs in scrollable container when no configs are pinned", () => {
		const manyConfigs = Array.from({ length: 10 }, (_, i) => ({
			id: `config${i + 1}`,
			name: `Config ${i + 1}`,
			modelId: `model-${i + 1}`,
		}))

		const props = {
			...defaultProps,
			listApiConfigMeta: manyConfigs,
			pinnedApiConfigs: {}, // No pinned configs
		}

		render(<ApiConfigSelector {...props} />)

		const trigger = screen.getByTestId("dropdown-trigger")
		fireEvent.click(trigger)

		const popoverContent = screen.getByTestId("popover-content")

		// Results keep a fixed height regardless of result count.
		const scrollContainer = popoverContent.querySelector(".h-\\[300px\\].overflow-y-auto")
		expect(scrollContainer).toBeInTheDocument()

		// No pinned section should exist when no configs are pinned
		const pinnedSection = scrollContainer?.querySelector(".sticky.top-0")
		expect(pinnedSection).not.toBeInTheDocument()

		// Should have unpinned configs section with all configs
		const unpinnedSection = scrollContainer?.querySelector('[aria-label="All configurations"]')
		expect(unpinnedSection).toBeInTheDocument()

		// All configs should be in the unpinned section
		const allConfigRows = unpinnedSection?.querySelectorAll(".group")
		expect(allConfigRows?.length).toBe(10)

		// No separator should exist when no pinned configs (no sticky header exists)
		const stickyHeader = scrollContainer?.querySelector(".sticky.top-0")
		expect(stickyHeader).not.toBeInTheDocument()
	})
})
