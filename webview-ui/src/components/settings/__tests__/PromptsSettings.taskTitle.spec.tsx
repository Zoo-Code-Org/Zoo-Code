// npx vitest src/components/settings/__tests__/PromptsSettings.taskTitle.spec.tsx

import React from "react"

import { render, screen, fireEvent } from "@/utils/test-utils"

import PromptsSettings from "../PromptsSettings"
import { vscode } from "@src/utils/vscode"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		listApiConfigMeta: [
			{ id: "cheap", name: "Cheap" },
			{ id: "big", name: "Big" },
		],
		enhancementApiConfigId: "",
		setEnhancementApiConfigId: vi.fn(),
		includeTaskHistoryInEnhance: true,
		setIncludeTaskHistoryInEnhance: vi.fn(),
	}),
}))

// Radix Select needs pointer APIs jsdom lacks; a native select keeps the value/change contract.
vi.mock("@src/components/ui", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	const Select = ({
		value,
		onValueChange,
		children,
	}: {
		value: string
		onValueChange: (value: string) => void
		children: React.ReactNode
	}) => (
		<select value={value} onChange={(e) => onValueChange(e.target.value)}>
			{children}
		</select>
	)
	const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>
	return {
		...actual,
		Select,
		SelectTrigger: () => null,
		SelectValue: () => null,
		SelectContent: Passthrough,
		SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
			<option value={value}>{children}</option>
		),
	}
})

const renderTaskTitleTab = (overrides: Record<string, unknown> = {}) => {
	const setTaskTitleGenerationEnabled = vi.fn()
	const setTaskTitleApiConfigId = vi.fn()
	render(
		<PromptsSettings
			customSupportPrompts={{}}
			setCustomSupportPrompts={vi.fn()}
			setTaskTitleGenerationEnabled={setTaskTitleGenerationEnabled}
			setTaskTitleApiConfigId={setTaskTitleApiConfigId}
			{...overrides}
		/>,
	)
	fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "TASK_TITLE" } })
	return { setTaskTitleGenerationEnabled, setTaskTitleApiConfigId }
}

const getCheckbox = () =>
	screen
		.getByText("prompts:supportPrompts.taskTitle.enabled")
		.closest("label")!
		.querySelector('input[type="checkbox"]') as HTMLInputElement

describe("PromptsSettings - TASK_TITLE tab", () => {
	beforeEach(() => vi.clearAllMocks())

	it("is hidden on other support prompt tabs", () => {
		render(<PromptsSettings customSupportPrompts={{}} setCustomSupportPrompts={vi.fn()} />)

		expect(screen.queryByText("prompts:supportPrompts.taskTitle.enabled")).not.toBeInTheDocument()
	})

	it.each([
		["defaults to enabled when unset", undefined, true],
		["reflects enabled", true, true],
		["reflects disabled", false, false],
	])("%s", (_label, value, checked) => {
		renderTaskTitleTab({ taskTitleGenerationEnabled: value })

		expect(getCheckbox().checked).toBe(checked)
	})

	it("buffers the toggle through the setter without persisting before Save", () => {
		const { setTaskTitleGenerationEnabled } = renderTaskTitleTab({ taskTitleGenerationEnabled: true })

		fireEvent.click(getCheckbox())

		expect(setTaskTitleGenerationEnabled).toHaveBeenCalledWith(false)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it.each([
		["selecting a profile", "cheap", "cheap"],
		["choosing the task profile", "-", ""],
	])("buffers %s through the setter without persisting before Save", (_label, selected, expected) => {
		const { setTaskTitleApiConfigId } = renderTaskTitleTab({ taskTitleApiConfigId: "big" })

		fireEvent.change(screen.getAllByRole("combobox")[1], { target: { value: selected } })

		expect(setTaskTitleApiConfigId).toHaveBeenCalledWith(expected)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})
})
