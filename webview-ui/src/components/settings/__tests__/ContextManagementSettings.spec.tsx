// npx vitest src/components/settings/__tests__/ContextManagementSettings.spec.tsx

import { render, screen, fireEvent, waitFor, within } from "@/utils/test-utils"
import { ContextManagementSettings } from "../ContextManagementSettings"
import { SearchIndexProvider } from "../useSettingsSearch"
import { vscode } from "@/utils/vscode"

// Mock the translation hook
vi.mock("@/hooks/useAppTranslation", () => ({
	useAppTranslation: () => ({
		t: (key: string) => {
			// Return specific translations for our test cases
			if (key === "settings:contextManagement.diagnostics.maxMessages.unlimitedLabel") {
				return "Unlimited"
			}
			return key
		},
	}),
}))

// Mock the UI components
vi.mock("@/components/ui", () => ({
	...vi.importActual("@/components/ui"),
	Slider: ({ value, onValueChange, "data-testid": dataTestId, disabled, min, max, "aria-label": ariaLabel }: any) => (
		<input
			type="range"
			value={value?.[0] ?? 0}
			min={min}
			max={max}
			onChange={(e) => onValueChange([parseFloat(e.target.value)])}
			onKeyDown={(e) => {
				const currentValue = value?.[0] ?? 0
				if (e.key === "ArrowRight") {
					onValueChange([currentValue + 1])
				} else if (e.key === "ArrowLeft") {
					onValueChange([currentValue - 1])
				}
			}}
			data-testid={dataTestId}
			disabled={disabled}
			role="slider"
			aria-label={ariaLabel}
		/>
	),
	Input: ({ value, onChange, "data-testid": dataTestId, ...props }: any) => (
		<input value={value} onChange={onChange} data-testid={dataTestId} {...props} />
	),
	Button: ({ children, onClick, ...props }: any) => (
		<button onClick={onClick} {...props}>
			{children}
		</button>
	),
	Select: ({ children, value, onValueChange, ...props }: any) => (
		<div role="combobox" data-value={value} {...props}>
			{/* Hidden trigger lets tests drive profile selection deterministically:
			    set data-next-value on the button, then click it. */}
			<button
				type="button"
				aria-hidden="true"
				data-testid="threshold-profile-change"
				onClick={(e: any) => onValueChange?.(e.currentTarget.getAttribute("data-next-value"))}
			/>
			{children}
		</div>
	),
	SelectTrigger: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	SelectValue: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	SelectContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	SelectItem: ({ children, ...props }: any) => <div {...props}>{children}</div>,
	StandardTooltip: ({ children, content }: any) => <div title={content}>{children}</div>,
}))

// Mock vscode utilities - this is necessary since we're not in a VSCode environment

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

// Records every event the mocked toolkit forwards to a checkbox onChange, keyed by
// data-testid, so tests can assert the component's handler actually received the event.
const forwardedCheckboxChanges = vi.hoisted(() => vi.fn())

// Mock VSCode components to behave like standard HTML elements
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ checked, onChange, children, "data-testid": dataTestId, ...props }: any) => (
		<label data-testid={dataTestId} {...props}>
			<input
				type="checkbox"
				role="checkbox"
				checked={checked || false}
				aria-checked={checked || false}
				onChange={(e: any) => {
					const event = { target: { checked: e.target.checked } }
					forwardedCheckboxChanges(dataTestId, event)
					onChange?.(event)
				}}
			/>
			{children}
		</label>
	),
	VSCodeTextArea: ({ value, onChange, ...props }: any) => <textarea value={value} onChange={onChange} {...props} />,
}))

describe("ContextManagementSettings", () => {
	const defaultProps = {
		autoCondenseContext: false,
		autoCondenseContextPercent: 80,
		idleCondenseContext: false,
		idleCondenseContextPercent: 50,
		idleCondenseTimeInSeconds: 180,
		listApiConfigMeta: [],
		maxOpenTabsContext: 20,
		maxWorkspaceFiles: 200,
		showRooIgnoredFiles: false,
		profileThresholds: {},
		profileIdleThresholds: {},
		profileIdleCondenseTimes: {},
		includeDiagnosticMessages: true,
		maxDiagnosticMessages: 50,
		writeDelayMs: 1000,
		customSupportPrompts: {},
		setCustomSupportPrompts: vi.fn(),
		setCachedStateField: vi.fn(),
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders diagnostic settings", () => {
		render(<ContextManagementSettings {...defaultProps} />)

		// Check for diagnostic checkbox
		expect(screen.getByTestId("include-diagnostic-messages-checkbox")).toBeInTheDocument()

		// Check for slider
		expect(screen.getByTestId("max-diagnostic-messages-slider")).toBeInTheDocument()
		expect(screen.getByText("50")).toBeInTheDocument()
	})

	it("renders with diagnostic messages enabled", () => {
		render(<ContextManagementSettings {...defaultProps} includeDiagnosticMessages={true} />)

		const checkbox = screen.getByTestId("include-diagnostic-messages-checkbox")
		expect(checkbox.querySelector("input")).toBeChecked()

		const slider = screen.getByTestId("max-diagnostic-messages-slider")
		expect(slider).toBeInTheDocument()
		expect(slider).toHaveValue("50")
	})

	it("renders with diagnostic messages disabled", () => {
		render(<ContextManagementSettings {...defaultProps} includeDiagnosticMessages={false} />)

		const checkbox = screen.getByTestId("include-diagnostic-messages-checkbox")
		expect(checkbox.querySelector("input")).not.toBeChecked()

		// Slider should still be rendered when diagnostics are disabled
		expect(screen.getByTestId("max-diagnostic-messages-slider")).toBeInTheDocument()
		expect(screen.getByText("50")).toBeInTheDocument()
	})

	it("calls setCachedStateField when include diagnostic messages checkbox is toggled", async () => {
		const setCachedStateField = vi.fn()
		render(<ContextManagementSettings {...defaultProps} setCachedStateField={setCachedStateField} />)

		const checkbox = screen.getByTestId("include-diagnostic-messages-checkbox").querySelector("input")!
		fireEvent.click(checkbox)

		await waitFor(() => {
			expect(setCachedStateField).toHaveBeenCalledWith("includeDiagnosticMessages", false)
		})
	})

	it("calls setCachedStateField when max diagnostic messages slider is changed", async () => {
		const setCachedStateField = vi.fn()
		render(<ContextManagementSettings {...defaultProps} setCachedStateField={setCachedStateField} />)

		const slider = screen.getByTestId("max-diagnostic-messages-slider")
		fireEvent.change(slider, { target: { value: "100" } })

		await waitFor(() => {
			expect(setCachedStateField).toHaveBeenCalledWith("maxDiagnosticMessages", -1)
		})
	})

	it("keeps slider visible when include diagnostic messages is unchecked", () => {
		const { rerender } = render(<ContextManagementSettings {...defaultProps} includeDiagnosticMessages={true} />)

		const slider = screen.getByTestId("max-diagnostic-messages-slider")
		expect(slider).toBeInTheDocument()

		// Update to disabled - slider should still be visible
		rerender(<ContextManagementSettings {...defaultProps} includeDiagnosticMessages={false} />)
		expect(screen.getByTestId("max-diagnostic-messages-slider")).toBeInTheDocument()
	})

	it("displays correct max diagnostic messages value", () => {
		const { rerender } = render(<ContextManagementSettings {...defaultProps} maxDiagnosticMessages={25} />)

		expect(screen.getByText("25")).toBeInTheDocument()

		// Update value - 100 should display as "Unlimited"
		rerender(<ContextManagementSettings {...defaultProps} maxDiagnosticMessages={100} />)
		expect(
			screen.getByText("settings:contextManagement.diagnostics.maxMessages.unlimitedLabel"),
		).toBeInTheDocument()

		// Test unlimited value (-1) displays as "Unlimited"
		rerender(<ContextManagementSettings {...defaultProps} maxDiagnosticMessages={-1} />)
		expect(
			screen.getByText("settings:contextManagement.diagnostics.maxMessages.unlimitedLabel"),
		).toBeInTheDocument()
	})

	it("renders other context management settings", () => {
		render(<ContextManagementSettings {...defaultProps} />)

		// Check for other sliders
		expect(screen.getByTestId("open-tabs-limit-slider")).toBeInTheDocument()
		expect(screen.getByTestId("workspace-files-limit-slider")).toBeInTheDocument()

		// Check for checkboxes
		expect(screen.getByTestId("show-rooignored-files-checkbox")).toBeInTheDocument()
		expect(screen.getByTestId("auto-condense-context-checkbox")).toBeInTheDocument()
	})

	describe("Edge cases for maxDiagnosticMessages", () => {
		it("handles zero value as unlimited", async () => {
			const setCachedStateField = vi.fn()
			render(
				<ContextManagementSettings
					{...defaultProps}
					maxDiagnosticMessages={0}
					setCachedStateField={setCachedStateField}
				/>,
			)

			// Zero is now treated as unlimited
			expect(
				screen.getByText("settings:contextManagement.diagnostics.maxMessages.unlimitedLabel"),
			).toBeInTheDocument()

			const slider = screen.getByTestId("max-diagnostic-messages-slider")
			// Zero should map to slider position 100 (unlimited)
			expect(slider).toHaveValue("100")
		})

		it("handles negative values as unlimited", async () => {
			const setCachedStateField = vi.fn()
			render(
				<ContextManagementSettings
					{...defaultProps}
					maxDiagnosticMessages={-10}
					setCachedStateField={setCachedStateField}
				/>,
			)

			// Component displays "Unlimited" for any negative value
			expect(
				screen.getByText("settings:contextManagement.diagnostics.maxMessages.unlimitedLabel"),
			).toBeInTheDocument()

			// Slider should be at max position (100) for negative values
			const slider = screen.getByTestId("max-diagnostic-messages-slider")
			expect(slider).toHaveValue("100")
		})

		it("handles very large numbers by capping at maximum", async () => {
			const setCachedStateField = vi.fn()
			const largeNumber = 1000
			render(
				<ContextManagementSettings
					{...defaultProps}
					maxDiagnosticMessages={largeNumber}
					setCachedStateField={setCachedStateField}
				/>,
			)

			// Should display the actual value even if it exceeds slider max
			expect(screen.getByText(largeNumber.toString())).toBeInTheDocument()

			// Slider value would be capped at max (100)
			const slider = screen.getByTestId("max-diagnostic-messages-slider")
			expect(slider).toHaveValue("100")
		})

		it("enforces maximum value constraint", async () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...defaultProps} setCachedStateField={setCachedStateField} />)

			const slider = screen.getByTestId("max-diagnostic-messages-slider")

			// Test that setting value above 100 gets capped
			fireEvent.change(slider, { target: { value: "150" } })

			await waitFor(() => {
				// Should be capped at 100, which maps to -1 (unlimited)
				expect(setCachedStateField).toHaveBeenCalledWith("maxDiagnosticMessages", -1)
			})
		})

		it("handles boundary value at minimum (1)", async () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...defaultProps} setCachedStateField={setCachedStateField} />)

			const slider = screen.getByTestId("max-diagnostic-messages-slider")
			fireEvent.change(slider, { target: { value: "1" } })

			await waitFor(() => {
				expect(setCachedStateField).toHaveBeenCalledWith("maxDiagnosticMessages", 1)
			})
		})

		it("handles boundary value at maximum (100) as unlimited (-1)", async () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...defaultProps} setCachedStateField={setCachedStateField} />)

			const slider = screen.getByTestId("max-diagnostic-messages-slider")
			fireEvent.change(slider, { target: { value: "100" } })

			await waitFor(() => {
				// When slider is at 100, it should set the value to -1 (unlimited)
				expect(setCachedStateField).toHaveBeenCalledWith("maxDiagnosticMessages", -1)
			})
		})

		it("handles decimal values by parsing as float", async () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...defaultProps} setCachedStateField={setCachedStateField} />)

			const slider = screen.getByTestId("max-diagnostic-messages-slider")
			fireEvent.change(slider, { target: { value: "50.7" } })

			await waitFor(() => {
				// The mock slider component parses as float
				expect(setCachedStateField).toHaveBeenCalledWith("maxDiagnosticMessages", 50.7)
			})
		})
	})

	it("renders with autoCondenseContext enabled", () => {
		const propsWithAutoCondense = {
			...defaultProps,
			autoCondenseContext: true,
			autoCondenseContextPercent: 75,
		}
		render(<ContextManagementSettings {...propsWithAutoCondense} />)

		// Should render the auto condense section
		const autoCondenseCheckbox = screen.getByTestId("auto-condense-context-checkbox")
		expect(autoCondenseCheckbox).toBeInTheDocument()

		// Should render the threshold slider with correct value
		const slider = screen.getByTestId("condense-threshold-slider")
		expect(slider).toBeInTheDocument()

		// Should render the profile select dropdown
		const selects = screen.getAllByRole("combobox")
		expect(selects).toHaveLength(1)
	})

	describe("Auto Condense Context functionality", () => {
		const autoCondenseProps = {
			...defaultProps,
			autoCondenseContext: true,
			autoCondenseContextPercent: 75,
			listApiConfigMeta: [
				{ id: "config-1", name: "Config 1" },
				{ id: "config-2", name: "Config 2" },
			],
		}

		it("toggles auto condense context setting", () => {
			const mockSetCachedStateField = vitest.fn()
			const props = { ...autoCondenseProps, setCachedStateField: mockSetCachedStateField }
			render(<ContextManagementSettings {...props} />)

			const checkbox = screen.getByTestId("auto-condense-context-checkbox")
			const input = checkbox.querySelector('input[type="checkbox"]')
			expect(input).toBeChecked()

			// Toggle off
			fireEvent.click(checkbox)
			expect(mockSetCachedStateField).toHaveBeenCalledWith("autoCondenseContext", false)
		})

		it("shows threshold settings when auto condense is enabled", () => {
			render(<ContextManagementSettings {...autoCondenseProps} />)

			// Threshold settings should be visible
			expect(screen.getByTestId("condense-threshold-slider")).toBeInTheDocument()
			// One combobox for profile selection
			expect(screen.getAllByRole("combobox")).toHaveLength(1)
		})

		it("updates auto condense context percent", () => {
			const mockSetCachedStateField = vitest.fn()
			const props = { ...autoCondenseProps, setCachedStateField: mockSetCachedStateField }
			render(<ContextManagementSettings {...props} />)

			// Find the condense threshold slider
			const slider = screen.getByTestId("condense-threshold-slider")

			// Test slider interaction
			slider.focus()
			fireEvent.keyDown(slider, { key: "ArrowRight" })

			expect(mockSetCachedStateField).toHaveBeenCalledWith("autoCondenseContextPercent", 76)
		})

		it("displays correct auto condense context percent value", () => {
			render(<ContextManagementSettings {...autoCondenseProps} />)
			expect(screen.getByText("75%")).toBeInTheDocument()
		})

		// Case 4: profileThresholds must buffer through cachedState, not persist before Save.
		it("buffers profile threshold changes without persisting before Save", () => {
			const mockSetCachedStateField = vitest.fn()
			const props = { ...autoCondenseProps, setCachedStateField: mockSetCachedStateField }
			render(<ContextManagementSettings {...props} />)

			// Select a non-default profile so the slider edits profileThresholds.
			const profileTrigger = screen.getByTestId("threshold-profile-change")
			profileTrigger.setAttribute("data-next-value", "config-1")
			fireEvent.click(profileTrigger)

			// Move the threshold slider for that profile.
			const slider = screen.getByTestId("condense-threshold-slider")
			slider.focus()
			fireEvent.keyDown(slider, { key: "ArrowRight" })

			expect(mockSetCachedStateField).toHaveBeenCalledWith("profileThresholds", { "config-1": 76 })
			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))
		})
	})

	it("handles boundary values for sliders", () => {
		const mockSetCachedStateField = vitest.fn()
		const props = {
			...defaultProps,
			maxOpenTabsContext: 0,
			maxWorkspaceFiles: 500,
			maxGitStatusFiles: 0,
			setCachedStateField: mockSetCachedStateField,
		}
		render(<ContextManagementSettings {...props} />)

		// Check boundary values are displayed by checking the slider values directly
		const openTabsSlider = screen.getByTestId("open-tabs-limit-slider")
		expect(openTabsSlider).toHaveValue("0")

		const workspaceFilesSlider = screen.getByTestId("workspace-files-limit-slider")
		expect(workspaceFilesSlider).toHaveValue("500")

		const gitStatusSlider = screen.getByTestId("max-git-status-files-slider")
		expect(gitStatusSlider).toHaveValue("0")
	})

	it("handles undefined optional props gracefully", () => {
		const propsWithUndefined = {
			...defaultProps,
			showRooIgnoredFiles: undefined,
		}

		expect(() => {
			render(<ContextManagementSettings {...propsWithUndefined} />)
		}).not.toThrow()

		// Should use default values
		expect(screen.getByText("20")).toBeInTheDocument() // default maxOpenTabsContext
		expect(screen.getByText("200")).toBeInTheDocument() // default maxWorkspaceFiles
	})

	describe("Conditional rendering", () => {
		it("does not render threshold settings when autoCondenseContext is false", () => {
			const propsWithoutAutoCondense = {
				...defaultProps,
				autoCondenseContext: false,
			}
			render(<ContextManagementSettings {...propsWithoutAutoCondense} />)

			// When auto condense is false, threshold slider should not be visible
			expect(screen.queryByTestId("condense-threshold-slider")).not.toBeInTheDocument()
		})

		it("does not render idle condensing controls when autoCondenseContext is false", () => {
			render(
				<ContextManagementSettings {...defaultProps} autoCondenseContext={false} idleCondenseContext={true} />,
			)

			// Idle condensing is nested under auto condense: everything idle
			// should be hidden while auto condense is unchecked.
			expect(screen.queryByTestId("idle-condense-context-checkbox")).not.toBeInTheDocument()
			expect(screen.queryByTestId("idle-condense-threshold-slider")).not.toBeInTheDocument()
			expect(screen.queryByTestId("idle-condense-time-input")).not.toBeInTheDocument()
		})

		it("renders idle condensing controls when autoCondenseContext is enabled", () => {
			render(
				<ContextManagementSettings {...defaultProps} autoCondenseContext={true} idleCondenseContext={true} />,
			)

			expect(screen.getByTestId("idle-condense-context-checkbox")).toBeInTheDocument()
			expect(screen.getByTestId("idle-condense-threshold-slider")).toBeInTheDocument()
			expect(screen.getByTestId("idle-condense-time-input")).toBeInTheDocument()
		})
	})

	describe("Accessibility", () => {
		it("has proper labels and descriptions", () => {
			render(<ContextManagementSettings {...defaultProps} />)

			// Check that labels are present
			expect(screen.getByText("settings:contextManagement.openTabs.label")).toBeInTheDocument()
			expect(screen.getByText("settings:contextManagement.workspaceFiles.label")).toBeInTheDocument()
			expect(screen.getByText("settings:contextManagement.rooignore.label")).toBeInTheDocument()

			// Check that descriptions are present
			expect(screen.getByText("settings:contextManagement.openTabs.description")).toBeInTheDocument()
			expect(screen.getByText("settings:contextManagement.workspaceFiles.description")).toBeInTheDocument()
			expect(screen.getByText("settings:contextManagement.rooignore.description")).toBeInTheDocument()
		})

		it("has proper test ids for all interactive elements", () => {
			render(<ContextManagementSettings {...defaultProps} />)

			expect(screen.getByTestId("open-tabs-limit-slider")).toBeInTheDocument()
			expect(screen.getByTestId("workspace-files-limit-slider")).toBeInTheDocument()
			expect(screen.getByTestId("show-rooignored-files-checkbox")).toBeInTheDocument()
		})
	})

	describe("Integration with translation system", () => {
		it("uses translation keys for all text content", () => {
			render(<ContextManagementSettings {...defaultProps} />)

			// Verify that translation keys are being used (mocked to return the key)
			expect(screen.getByText("settings:sections.contextManagement")).toBeInTheDocument()
			expect(screen.getByText("settings:contextManagement.description")).toBeInTheDocument()
			expect(screen.getByText("settings:contextManagement.openTabs.label")).toBeInTheDocument()
			expect(screen.getByText("settings:contextManagement.workspaceFiles.label")).toBeInTheDocument()
			expect(screen.getByText("settings:contextManagement.rooignore.label")).toBeInTheDocument()
		})
	})

	describe("diffFuzzyThreshold", () => {
		it("renders diff fuzzy threshold slider with default value", () => {
			render(<ContextManagementSettings {...defaultProps} />)

			const slider = screen.getByTestId("diff-fuzzy-threshold-slider")
			expect(slider).toBeInTheDocument()
		})

		it("calls setCachedStateField when slider changes", async () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...defaultProps} setCachedStateField={setCachedStateField} />)

			const slider = screen.getByTestId("diff-fuzzy-threshold-slider")
			fireEvent.change(slider, { target: { value: "0.85" } })

			await waitFor(() => {
				expect(setCachedStateField).toHaveBeenCalledWith("diffFuzzyThreshold", 0.85)
			})
		})
	})

	describe("Idle Condensing", () => {
		const idleProps = {
			...defaultProps,
			autoCondenseContext: true,
			autoCondenseContextPercent: 100,
			idleCondenseContext: true,
			idleCondenseContextPercent: 50,
			idleCondenseTimeInSeconds: 180,
			listApiConfigMeta: [
				{ id: "config-1", name: "Config 1" },
				{ id: "config-2", name: "Config 2" },
			],
		}

		const selectIdleProfile = (profileId: string) => {
			const idleSelect = screen.getByTestId("idle-threshold-profile-select")
			const trigger = idleSelect.querySelector('button[data-testid="threshold-profile-change"]')
			if (!trigger) {
				throw new Error("idle profile trigger not found")
			}
			trigger.setAttribute("data-next-value", profileId)
			fireEvent.click(trigger)
		}

		it("does not render idle controls when idle condensing is disabled", () => {
			render(<ContextManagementSettings {...defaultProps} idleCondenseContext={false} />)

			expect(screen.queryByTestId("idle-condense-threshold-slider")).not.toBeInTheDocument()
			expect(screen.queryByTestId("idle-condense-time-input")).not.toBeInTheDocument()
		})

		it("registers the idle time label for settings search even when idle condensing is disabled", () => {
			// Settings search indexes each tab once during the initial cycling
			// phase, when idle condensing is still off. The idle time label must
			// already be searchable at that point even though its control is
			// hidden until the feature is enabled.
			const registerSetting = vi.fn()
			render(
				<SearchIndexProvider value={{ registerSetting }}>
					<ContextManagementSettings {...defaultProps} idleCondenseContext={false} />
				</SearchIndexProvider>,
			)

			expect(registerSetting).toHaveBeenCalledWith({
				settingId: "context-idle-time",
				section: "contextManagement",
				label: "settings:contextManagement.idleCondensing.idleTime.label",
			})
			// The control itself stays hidden while the feature is off.
			expect(screen.queryByTestId("idle-condense-time-input")).not.toBeInTheDocument()
		})

		it("marks the rendered idle time control with the registered search id", () => {
			// Search navigation finds the control via [data-setting-id], so the
			// rendered control must carry the same id the label was registered with.
			render(<ContextManagementSettings {...idleProps} />)

			const setting = document.querySelector('[data-setting-id="context-idle-time"]')
			expect(setting).not.toBeNull()
			expect(within(setting as HTMLElement).getByTestId("idle-condense-time-input")).toBeInTheDocument()
		})

		it("toggles idle condensing setting", () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...idleProps} setCachedStateField={setCachedStateField} />)

			const checkbox = screen.getByTestId("idle-condense-context-checkbox")
			expect(checkbox.querySelector('input[type="checkbox"]')).toBeChecked()

			fireEvent.click(checkbox)
			expect(setCachedStateField).toHaveBeenCalledWith("idleCondenseContext", false)
		})

		it("renders idle threshold slider and time input with current values", () => {
			render(<ContextManagementSettings {...idleProps} />)

			expect(screen.getByTestId("idle-threshold-profile-select")).toBeInTheDocument()
			expect(screen.getByTestId("idle-condense-threshold-slider")).toHaveValue("50")
			expect(screen.getByTestId("idle-condense-time-input")).toHaveValue(180)
		})

		it("updates the global idle threshold", () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...idleProps} setCachedStateField={setCachedStateField} />)

			const slider = screen.getByTestId("idle-condense-threshold-slider")
			fireEvent.change(slider, { target: { value: "70" } })

			expect(setCachedStateField).toHaveBeenCalledWith("idleCondenseContextPercent", 70)
		})

		it("keeps the idle slider max at 100 regardless of the main threshold", () => {
			render(<ContextManagementSettings {...idleProps} autoCondenseContextPercent={40} />)

			const slider = screen.getByTestId("idle-condense-threshold-slider")
			expect(slider).toHaveAttribute("max", "100")
		})

		it("shows the effective clamped idle threshold on initial render", () => {
			// A 50% idle threshold under a 40% main threshold runs at 40%, so the
			// initial display must agree with the runtime instead of showing 50%.
			// Read-only: no interaction, and nothing may be written to cached state.
			const setCachedStateField = vi.fn()
			render(
				<ContextManagementSettings
					{...idleProps}
					autoCondenseContextPercent={40}
					idleCondenseContextPercent={50}
					setCachedStateField={setCachedStateField}
				/>,
			)

			const slider = screen.getByTestId("idle-condense-threshold-slider")
			expect(slider).toHaveValue("40")
			// The percentage shown beside the idle slider (scoped so the main
			// threshold slider's own 40% label cannot satisfy the assertion).
			expect(within(slider.parentElement as HTMLElement).getByText("40%")).toBeInTheDocument()
			expect(setCachedStateField).not.toHaveBeenCalled()
		})

		it("allows idle thresholds down to the shared minimum threshold", () => {
			render(<ContextManagementSettings {...idleProps} />)

			// The runtime accepts idle overrides as low as MIN_CONDENSE_THRESHOLD (5),
			// so the slider must not floor the user at 10.
			const slider = screen.getByTestId("idle-condense-threshold-slider")
			expect(slider).toHaveAttribute("min", "5")
		})

		it("gives the idle slider an accessible name", () => {
			render(<ContextManagementSettings {...idleProps} />)

			// The mocked t() returns the key itself, so this asserts the translated
			// idle-condensing label is wired to the slider as its aria-label.
			const slider = screen.getByTestId("idle-condense-threshold-slider")
			expect(slider).toHaveAttribute("aria-label", "settings:contextManagement.idleCondensing.name")
		})

		it("parses an exponent idle time pasted into the idle time input as a full number", () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...idleProps} setCachedStateField={setCachedStateField} />)

			// parseInt stops at "e", turning a pasted "1e3" into 1 second; Number
			// reads it as 1000.
			fireEvent.change(screen.getByTestId("idle-condense-time-input"), { target: { value: "1e3" } })
			expect(setCachedStateField).toHaveBeenCalledWith("idleCondenseTimeInSeconds", 1000)

			setCachedStateField.mockClear()
			fireEvent.change(screen.getByTestId("idle-condense-time-input"), { target: { value: "90.4" } })
			expect(setCachedStateField).toHaveBeenCalledWith("idleCondenseTimeInSeconds", 90)

			// Empty input still falls back to zero rather than NaN.
			setCachedStateField.mockClear()
			fireEvent.change(screen.getByTestId("idle-condense-time-input"), { target: { value: "" } })
			expect(setCachedStateField).toHaveBeenCalledWith("idleCondenseTimeInSeconds", 0)
		})

		it("clamps the idle threshold value to the main condense threshold", () => {
			const setCachedStateField = vi.fn()
			render(
				<ContextManagementSettings
					{...idleProps}
					autoCondenseContextPercent={40}
					setCachedStateField={setCachedStateField}
				/>,
			)

			const slider = screen.getByTestId("idle-condense-threshold-slider")
			// Nudging above the main threshold writes the clamped value.
			slider.focus()
			fireEvent.keyDown(slider, { key: "ArrowRight" })

			expect(setCachedStateField).toHaveBeenCalledWith("idleCondenseContextPercent", 40)
		})

		it("lowers the current idle threshold when the trigger threshold is reduced", () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...idleProps} setCachedStateField={setCachedStateField} />)

			const triggerSlider = screen.getByTestId("condense-threshold-slider")
			fireEvent.change(triggerSlider, { target: { value: "40" } })

			expect(setCachedStateField).toHaveBeenCalledWith("autoCondenseContextPercent", 40)
			expect(setCachedStateField).toHaveBeenCalledWith("idleCondenseContextPercent", 40)
		})

		it("leaves the idle threshold alone when the trigger threshold change does not exceed it", () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...idleProps} setCachedStateField={setCachedStateField} />)

			const triggerSlider = screen.getByTestId("condense-threshold-slider")
			fireEvent.change(triggerSlider, { target: { value: "80" } })

			expect(setCachedStateField).toHaveBeenCalledWith("autoCondenseContextPercent", 80)
			expect(setCachedStateField).not.toHaveBeenCalledWith("idleCondenseContextPercent", expect.anything())
		})

		it("lowers a profile idle override when its trigger threshold is reduced", () => {
			const setCachedStateField = vi.fn()
			render(
				<ContextManagementSettings
					{...idleProps}
					profileThresholds={{ "config-1": 80 }}
					profileIdleThresholds={{ "config-1": 70 }}
					setCachedStateField={setCachedStateField}
				/>,
			)

			// Select config-1 in the trigger-threshold profile picker.
			const triggerSelect = screen.getByTestId("threshold-profile-select")
			const trigger = triggerSelect.querySelector('button[data-testid="threshold-profile-change"]')
			if (!trigger) {
				throw new Error("trigger profile trigger not found")
			}
			trigger.setAttribute("data-next-value", "config-1")
			fireEvent.click(trigger)

			const triggerSlider = screen.getByTestId("condense-threshold-slider")
			fireEvent.change(triggerSlider, { target: { value: "60" } })

			expect(setCachedStateField).toHaveBeenCalledWith("profileThresholds", { "config-1": 60 })
			expect(setCachedStateField).toHaveBeenCalledWith("profileIdleThresholds", { "config-1": 60 })
		})

		it("updates the global idle time", () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...idleProps} setCachedStateField={setCachedStateField} />)

			const input = screen.getByTestId("idle-condense-time-input")
			fireEvent.change(input, { target: { value: "60" } })

			expect(setCachedStateField).toHaveBeenCalledWith("idleCondenseTimeInSeconds", 60)
		})

		it("clamps a negative idle time to zero", () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...idleProps} setCachedStateField={setCachedStateField} />)

			const input = screen.getByTestId("idle-condense-time-input")
			fireEvent.change(input, { target: { value: "-5" } })

			expect(setCachedStateField).toHaveBeenCalledWith("idleCondenseTimeInSeconds", 0)
		})

		it("writes profile-scoped idle threshold overrides", () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...idleProps} setCachedStateField={setCachedStateField} />)

			selectIdleProfile("config-1")

			const slider = screen.getByTestId("idle-condense-threshold-slider")
			fireEvent.change(slider, { target: { value: "55" } })

			expect(setCachedStateField).toHaveBeenCalledWith("profileIdleThresholds", { "config-1": 55 })
			expect(setCachedStateField).not.toHaveBeenCalledWith("idleCondenseContextPercent", expect.anything())
		})

		it("writes profile-scoped idle time overrides", () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...idleProps} setCachedStateField={setCachedStateField} />)

			selectIdleProfile("config-1")

			const input = screen.getByTestId("idle-condense-time-input")
			fireEvent.change(input, { target: { value: "90" } })

			expect(setCachedStateField).toHaveBeenCalledWith("profileIdleCondenseTimes", { "config-1": 90 })
			expect(setCachedStateField).not.toHaveBeenCalledWith("idleCondenseTimeInSeconds", expect.anything())
		})

		it("resets profile idle overrides to global via the use-global button", () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...idleProps} setCachedStateField={setCachedStateField} />)

			selectIdleProfile("config-1")

			const button = screen.getByTestId("idle-condense-use-global-button")
			fireEvent.click(button)

			expect(setCachedStateField).toHaveBeenCalledWith("profileIdleThresholds", { "config-1": -1 })
			expect(setCachedStateField).toHaveBeenCalledWith("profileIdleCondenseTimes", { "config-1": -1 })
		})

		it("buffers profile idle changes without persisting before Save", () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...idleProps} setCachedStateField={setCachedStateField} />)

			selectIdleProfile("config-1")

			const slider = screen.getByTestId("idle-condense-threshold-slider")
			slider.focus()
			fireEvent.keyDown(slider, { key: "ArrowRight" })

			expect(setCachedStateField).toHaveBeenCalledWith("profileIdleThresholds", { "config-1": 51 })
			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))
		})

		it("displays an inherited idle threshold capped at the profile main threshold", () => {
			// Runtime resolves idlePercent = Math.min(idlePercentSetting, mainPercent)
			// per profile, so a profile inheriting the 50% global idle threshold
			// while capping at a 30% main threshold must display 30%, not 50%.
			render(
				<ContextManagementSettings
					{...idleProps}
					idleCondenseContextPercent={50}
					profileThresholds={{ "config-1": 30 }}
				/>,
			)

			selectIdleProfile("config-1")

			expect(screen.getByTestId("idle-condense-threshold-slider")).toHaveValue("30")
			expect(screen.getByText("30%")).toBeInTheDocument()
		})

		it("displays a profile idle override above its main threshold as capped", () => {
			render(
				<ContextManagementSettings
					{...idleProps}
					profileThresholds={{ "config-1": 40 }}
					profileIdleThresholds={{ "config-1": 70 }}
				/>,
			)

			selectIdleProfile("config-1")

			expect(screen.getByTestId("idle-condense-threshold-slider")).toHaveValue("40")
			expect(screen.getByText("40%")).toBeInTheDocument()
		})

		it("leaves a profile idle override below its main threshold uncapped", () => {
			render(
				<ContextManagementSettings
					{...idleProps}
					profileThresholds={{ "config-1": 40 }}
					profileIdleThresholds={{ "config-1": 20 }}
				/>,
			)

			selectIdleProfile("config-1")

			expect(screen.getByTestId("idle-condense-threshold-slider")).toHaveValue("20")
			expect(screen.getByText("20%")).toBeInTheDocument()
		})

		it("caps the displayed global idle threshold at the main condense threshold", () => {
			// Runtime resolves idlePercent = Math.min(idlePercent, mainPercent), so a
			// saved 50% idle threshold against a 40% main threshold must display 40%
			// the moment idle condensing is shown, not only after a save.
			render(<ContextManagementSettings {...idleProps} autoCondenseContextPercent={40} />)

			expect(screen.getByTestId("idle-condense-threshold-slider")).toHaveValue("40")
		})

		it("displays the global main threshold for an invalid profile main override", () => {
			// An imported profile main override outside [5, 100] is ignored at
			// runtime, which falls back to the global threshold. Displaying the raw
			// value would both misreport the threshold and cap idle edits to it.
			render(
				<ContextManagementSettings
					{...idleProps}
					idleCondenseContextPercent={50}
					profileThresholds={{ "config-1": -99 }}
				/>,
			)

			selectIdleProfile("config-1")

			expect(screen.getByTestId("idle-condense-threshold-slider")).toHaveValue("50")
			expect(screen.getByTestId("condense-threshold-slider")).toHaveValue("100")
		})

		it("displays the global idle threshold for an invalid profile idle override", () => {
			render(
				<ContextManagementSettings
					{...idleProps}
					idleCondenseContextPercent={50}
					profileThresholds={{ "config-1": 80 }}
					profileIdleThresholds={{ "config-1": 150 }}
				/>,
			)

			selectIdleProfile("config-1")

			expect(screen.getByTestId("idle-condense-threshold-slider")).toHaveValue("50")
		})

		it("displays the global idle time for an invalid profile idle time override", () => {
			render(<ContextManagementSettings {...idleProps} profileIdleCondenseTimes={{ "config-1": -42 }} />)

			selectIdleProfile("config-1")

			expect(screen.getByTestId("idle-condense-time-input")).toHaveValue(180)
		})

		it("clamps inheriting profile idle overrides when the default trigger threshold is reduced", () => {
			const setCachedStateField = vi.fn()
			render(
				<ContextManagementSettings
					{...idleProps}
					profileThresholds={{ "config-2": 90 }}
					profileIdleThresholds={{ "config-1": -1, "config-2": 70, "config-3": 50 }}
					setCachedStateField={setCachedStateField}
				/>,
			)

			const triggerSlider = screen.getByTestId("condense-threshold-slider")
			fireEvent.change(triggerSlider, { target: { value: "40" } })

			// config-1 keeps its -1 inheritance, config-2 follows its own profile trigger
			// (90) and stays 70, and only config-3, which inherits the default trigger,
			// follows the lowered threshold down to 40.
			expect(setCachedStateField).toHaveBeenCalledWith("profileIdleThresholds", {
				"config-1": -1,
				"config-2": 70,
				"config-3": 40,
			})
		})

		it("displays a profile idle time override in the idle time input", () => {
			render(<ContextManagementSettings {...idleProps} profileIdleCondenseTimes={{ "config-1": 42 }} />)

			selectIdleProfile("config-1")

			expect(screen.getByTestId("idle-condense-time-input")).toHaveValue(42)
		})

		it("shows each profile's idle threshold override as a suffix in the profile select", () => {
			render(<ContextManagementSettings {...idleProps} profileIdleThresholds={{ "config-1": 55 }} />)

			const idleSelect = screen.getByTestId("idle-threshold-profile-select")
			expect(within(idleSelect).getByText("Config 1 (55%)")).toBeInTheDocument()
			// A profile without an override shows no suffix.
			expect(within(idleSelect).getByText("Config 2")).toBeInTheDocument()
		})

		it("ignores an idle condense checkbox change whose target has no boolean checked value", () => {
			const setCachedStateField = vi.fn()
			render(<ContextManagementSettings {...idleProps} setCachedStateField={setCachedStateField} />)

			const input = screen.getByTestId("idle-condense-context-checkbox").querySelector('input[type="checkbox"]')!
			// Simulate an event whose target lacks a boolean `checked`: the mocked toolkit
			// forwards { target: { checked: undefined } }, so the component's guard must
			// reject it. React fires the checkbox onChange on click, and the no-op setter
			// keeps jsdom's activation behavior from throwing on the getter-only override.
			Object.defineProperty(input, "checked", { get: () => undefined, set: () => {}, configurable: true })
			fireEvent.click(input)

			// expect.anything() would not match an `undefined` value, so also verify the
			// handler did receive the malformed event before asserting nothing was written.
			expect(forwardedCheckboxChanges).toHaveBeenCalledWith("idle-condense-context-checkbox", {
				target: { checked: undefined },
			})
			expect(setCachedStateField).not.toHaveBeenCalled()
		})
	})
})
