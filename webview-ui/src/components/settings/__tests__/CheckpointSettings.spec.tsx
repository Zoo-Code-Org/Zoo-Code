// npx vitest src/components/settings/__tests__/CheckpointSettings.spec.tsx

import type { ReactNode } from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import { CheckpointSettings } from "../CheckpointSettings"

// Mock the translation hook
vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => {
			if (key === "settings:checkpoints.perWrite.label") {
				return "Checkpoint after each file write"
			}
			if (key === "settings:checkpoints.perWrite.description") {
				return "Record a checkpoint snapshot after every successful file write by the agent"
			}
			if (key === "settings:checkpoints.changeCardDetail.label") {
				return "Show full diff in change cards"
			}
			if (key === "settings:checkpoints.changeCardDetail.description") {
				return "Include the full unified diff inline in per-step change cards"
			}
			return key
		},
	}),
}))

// Mock the UI components (async factory: vi.importActual resolves asynchronously).
vi.mock("@/components/ui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/components/ui")>()
	return {
		...actual,
		// Narrow typed double: only the props CheckpointSettings consumes, so
		// drift in the Slider contract is a compile error here, not `any`.
		Slider: ({
			defaultValue,
			onValueChange,
			"data-testid": dataTestId,
		}: {
			defaultValue?: number[]
			onValueChange?: (value: number[]) => void
			"data-testid"?: string
		}) => (
			<input
				type="range"
				value={defaultValue?.[0] ?? 0}
				onChange={() => onValueChange?.([100])}
				data-testid={dataTestId}
				role="slider"
			/>
		),
	}
})

// Mock vscode utilities
vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

// Mock VSCode components to behave like standard HTML elements
vi.mock("@vscode/webview-ui-toolkit/react", () => {
	// Narrow event double: the real toolkit dispatches a native Event whose
	// currentTarget is the web component with a boolean `checked`; the mock
	// forwards the input's checked state on both target and currentTarget so
	// handlers can be typed against either surface.
	type CheckboxChangeEvent = {
		target: { checked: boolean }
		currentTarget: { checked: boolean }
	}
	return {
		VSCodeCheckbox: ({
			checked,
			onChange,
			children,
			"data-testid": dataTestId,
		}: {
			checked?: boolean
			onChange?: (e: CheckboxChangeEvent) => void
			children?: ReactNode
			"data-testid"?: string
		}) => (
			<label data-testid={dataTestId}>
				<input
					type="checkbox"
					role="checkbox"
					checked={checked || false}
					aria-checked={checked || false}
					onChange={(e) => {
						const value = e.currentTarget.checked
						onChange?.({ target: { checked: value }, currentTarget: { checked: value } })
					}}
				/>
				{children}
			</label>
		),
		VSCodeLink: ({ children, href }: { children?: ReactNode; href?: string }) => <a href={href}>{children}</a>,
	}
})

describe("CheckpointSettings", () => {
	const setCachedStateField = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders the per-write checkpoints checkbox checked by default when the value is unset", () => {
		render(<CheckpointSettings enableCheckpoints={false} setCachedStateField={setCachedStateField} />)

		const checkbox = screen.getByRole("checkbox", { name: "Checkpoint after each file write" })
		expect(checkbox).toBeChecked()
	})

	it("unchecks the per-write checkpoints checkbox when the saved value is false", () => {
		render(
			<CheckpointSettings
				enableCheckpoints={false}
				perWriteCheckpoints={false}
				setCachedStateField={setCachedStateField}
			/>,
		)

		const checkbox = screen.getByRole("checkbox", { name: "Checkpoint after each file write" })
		expect(checkbox).not.toBeChecked()
	})

	it("keeps the per-write checkpoints checkbox checked when the saved value is true", () => {
		render(
			<CheckpointSettings
				enableCheckpoints={false}
				perWriteCheckpoints={true}
				setCachedStateField={setCachedStateField}
			/>,
		)

		const checkbox = screen.getByRole("checkbox", { name: "Checkpoint after each file write" })
		expect(checkbox).toBeChecked()
	})

	it("caches a toggle to enable per-write checkpoints when the user checks the box", () => {
		render(
			<CheckpointSettings
				enableCheckpoints={false}
				perWriteCheckpoints={false}
				setCachedStateField={setCachedStateField}
			/>,
		)

		const checkbox = screen.getByRole("checkbox", { name: "Checkpoint after each file write" })
		fireEvent.click(checkbox)

		expect(setCachedStateField).toHaveBeenCalledWith("perWriteCheckpoints", true)
	})

	it("caches a toggle to disable per-write checkpoints when the user unchecks the box", () => {
		render(<CheckpointSettings enableCheckpoints={false} setCachedStateField={setCachedStateField} />)

		const checkbox = screen.getByRole("checkbox", { name: "Checkpoint after each file write" })
		fireEvent.click(checkbox)

		expect(setCachedStateField).toHaveBeenCalledWith("perWriteCheckpoints", false)
	})

	it("renders the change-card detail checkbox unchecked by default when the value is unset", () => {
		// The default is "summary", so the "full" checkbox is off.
		render(<CheckpointSettings enableCheckpoints={false} setCachedStateField={setCachedStateField} />)

		const checkbox = screen.getByRole("checkbox", { name: "Show full diff in change cards" })
		expect(checkbox).not.toBeChecked()
	})

	it("renders the change-card detail checkbox checked when the saved value is full", () => {
		render(
			<CheckpointSettings
				enableCheckpoints={false}
				changeCardDetail="full"
				setCachedStateField={setCachedStateField}
			/>,
		)

		const checkbox = screen.getByRole("checkbox", { name: "Show full diff in change cards" })
		expect(checkbox).toBeChecked()
	})

	it("caches full when the user enables the change-card detail checkbox", () => {
		render(<CheckpointSettings enableCheckpoints={false} setCachedStateField={setCachedStateField} />)

		const checkbox = screen.getByRole("checkbox", { name: "Show full diff in change cards" })
		fireEvent.click(checkbox)

		expect(setCachedStateField).toHaveBeenCalledWith("changeCardDetail", "full")
	})

	it("caches summary when the user disables the change-card detail checkbox", () => {
		render(
			<CheckpointSettings
				enableCheckpoints={false}
				changeCardDetail="full"
				setCachedStateField={setCachedStateField}
			/>,
		)

		const checkbox = screen.getByRole("checkbox", { name: "Show full diff in change cards" })
		fireEvent.click(checkbox)

		expect(setCachedStateField).toHaveBeenCalledWith("changeCardDetail", "summary")
	})
})
