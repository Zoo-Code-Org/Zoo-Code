import { render, screen, fireEvent } from "@testing-library/react"

import type { AutocompleteProfile } from "@roo-code/types"

import { TooltipProvider } from "../../ui/tooltip"
import { AutocompleteProfileBar } from "../autocomplete/AutocompleteProfileBar"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const profiles: AutocompleteProfile[] = [
	{ id: "p1", name: "Local Qwen", config: { provider: "ollama", modelId: "qwen2.5-coder:1.5b-base" } },
	{ id: "p2", name: "Cloud Codestral", config: { provider: "codestral", modelId: "codestral-latest" } },
]

const renderBar = (props: Partial<React.ComponentProps<typeof AutocompleteProfileBar>> = {}) => {
	const handlers = {
		onSelect: vi.fn(),
		onSave: vi.fn(),
		onRename: vi.fn(),
		onDelete: vi.fn(),
	}

	// The real tree supplies this from App.tsx; the bar's tooltips require it.
	const utils = render(
		<TooltipProvider>
			<AutocompleteProfileBar profiles={profiles} activeProfileId="p1" isDirty={false} {...handlers} {...props} />
		</TooltipProvider>,
	)

	return { ...utils, ...handlers }
}

describe("AutocompleteProfileBar", () => {
	it("disables rename and delete when no profile is active", () => {
		renderBar({ activeProfileId: undefined })

		expect(screen.getByTestId("autocomplete-profile-rename")).toBeDisabled()
		expect(screen.getByTestId("autocomplete-profile-delete")).toBeDisabled()
	})

	it("deletes the active profile", () => {
		const { onDelete } = renderBar()

		fireEvent.click(screen.getByTestId("autocomplete-profile-delete"))

		expect(onDelete).toHaveBeenCalledWith("p1")
	})

	it("saves a new profile under the typed name", () => {
		const { onSave } = renderBar()

		fireEvent.click(screen.getByTestId("autocomplete-profile-add"))
		fireEvent.input(screen.getByTestId("autocomplete-profile-name-input"), { target: { value: "Fast local" } })
		fireEvent.click(screen.getByTestId("autocomplete-profile-confirm"))

		expect(onSave).toHaveBeenCalledWith("Fast local")
	})

	it("renames rather than creating when the rename affordance is used", () => {
		const { onRename, onSave } = renderBar()

		fireEvent.click(screen.getByTestId("autocomplete-profile-rename"))
		fireEvent.input(screen.getByTestId("autocomplete-profile-name-input"), { target: { value: "Renamed" } })
		fireEvent.click(screen.getByTestId("autocomplete-profile-confirm"))

		expect(onRename).toHaveBeenCalledWith("p1", "Renamed")
		expect(onSave).not.toHaveBeenCalled()
	})

	it("refuses to save a blank name", () => {
		const { onSave } = renderBar()

		fireEvent.click(screen.getByTestId("autocomplete-profile-add"))
		fireEvent.input(screen.getByTestId("autocomplete-profile-name-input"), { target: { value: "   " } })

		expect(screen.getByTestId("autocomplete-profile-confirm")).toBeDisabled()
		expect(onSave).not.toHaveBeenCalled()
	})

	it("abandons the edit on cancel", () => {
		const { onSave } = renderBar()

		fireEvent.click(screen.getByTestId("autocomplete-profile-add"))
		fireEvent.input(screen.getByTestId("autocomplete-profile-name-input"), { target: { value: "Discarded" } })
		fireEvent.click(screen.getByTestId("autocomplete-profile-cancel"))

		expect(onSave).not.toHaveBeenCalled()
		expect(screen.queryByTestId("autocomplete-profile-editor")).not.toBeInTheDocument()
	})

	it("surfaces unsaved changes against the active profile", () => {
		renderBar({ isDirty: true })

		expect(screen.getByText(/unsavedChanges/)).toBeInTheDocument()
	})

	it("blocks new profiles once the limit is reached", () => {
		const many = Array.from({ length: 20 }, (_, i) => ({
			id: `p${i}`,
			name: `Profile ${i}`,
			config: {},
		}))

		renderBar({ profiles: many, activeProfileId: "p0" })

		expect(screen.getByTestId("autocomplete-profile-add")).toBeDisabled()
	})
})
