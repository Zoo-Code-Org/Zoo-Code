// npx vitest src/components/settings/__tests__/CheckpointSettings.spec.tsx

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
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ checked, onChange, children, ...props }: any) => (
		<label {...props}>
			<input
				type="checkbox"
				role="checkbox"
				checked={checked || false}
				aria-checked={checked || false}
				onChange={(e: any) => onChange?.({ target: { checked: e.target.checked } })}
			/>
			{children}
		</label>
	),
	VSCodeLink: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}))

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
})
