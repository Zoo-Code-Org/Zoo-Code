// npx vitest src/components/settings/__tests__/CheckpointSettings.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"
import { CheckpointSettings } from "../CheckpointSettings"
import enSettings from "@/i18n/locales/en/settings.json"
import caSettings from "@/i18n/locales/ca/settings.json"
import deSettings from "@/i18n/locales/de/settings.json"
import esSettings from "@/i18n/locales/es/settings.json"
import frSettings from "@/i18n/locales/fr/settings.json"
import hiSettings from "@/i18n/locales/hi/settings.json"
import idSettings from "@/i18n/locales/id/settings.json"
import itSettings from "@/i18n/locales/it/settings.json"
import jaSettings from "@/i18n/locales/ja/settings.json"
import koSettings from "@/i18n/locales/ko/settings.json"
import nlSettings from "@/i18n/locales/nl/settings.json"
import plSettings from "@/i18n/locales/pl/settings.json"
import ptBRSettings from "@/i18n/locales/pt-BR/settings.json"
import ruSettings from "@/i18n/locales/ru/settings.json"
import trSettings from "@/i18n/locales/tr/settings.json"
import viSettings from "@/i18n/locales/vi/settings.json"
import zhCNSettings from "@/i18n/locales/zh-CN/settings.json"
import zhTWSettings from "@/i18n/locales/zh-TW/settings.json"
// The per-write checkpoint setting ships a description in every locale file, and the render
// above mocks the translation hook, so the shipped copy is asserted against the locale
// resources themselves. Access goes through a guard rather than a cast so a missing key
// fails loudly instead of comparing undefined.
// The three tools whose successful writes record a checkpoint.
const WRITE_TOOLS = ["write_to_file", "edit_file", "apply_patch"]

const localeSettings: Record<string, unknown> = {
	en: enSettings,
	ca: caSettings,
	de: deSettings,
	es: esSettings,
	fr: frSettings,
	hi: hiSettings,
	id: idSettings,
	it: itSettings,
	ja: jaSettings,
	ko: koSettings,
	nl: nlSettings,
	pl: plSettings,
	"pt-BR": ptBRSettings,
	ru: ruSettings,
	tr: trSettings,
	vi: viSettings,
	"zh-CN": zhCNSettings,
	"zh-TW": zhTWSettings,
}

function perWriteDescription(settings: unknown): string {
	const resources = settings as { checkpoints?: { perWrite?: { description?: unknown } } }
	const description = resources.checkpoints?.perWrite?.description
	if (typeof description !== "string") {
		throw new Error("settings.checkpoints.perWrite.description is missing")
	}
	return description
}

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
		Slider: ({ defaultValue, onValueChange, "data-testid": dataTestId }: any) => (
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

	it.each(Object.entries(localeSettings).map(([locale, settings]) => ({ locale, settings })))(
		"names the three writing tools in the $locale per-write checkpoint description",
		({ locale, settings }) => {
			const description = perWriteDescription(settings)
			// The tool identifiers are language-neutral, so every locale can be held to the same
			// names: the setting records a checkpoint for these tools only, and the copy has to
			// say so instead of promising a snapshot after every write operation.
			expect(WRITE_TOOLS.filter((toolName) => !description.includes(toolName))).toEqual([])
			if (locale !== "en") {
				// The description is genuinely localized: a locale left on the English copy is a
				// missing translation, not a parity match.
				expect(description).not.toBe(perWriteDescription(localeSettings.en))
			}
		},
	)

	it("states that saving from the editor records no checkpoint", () => {
		// The checkpoint call sites are the agent's three writing tools; an editor save does
		// not go through them, so the copy must not imply that it does.
		expect(perWriteDescription(localeSettings.en)).toContain("Saving a file from the editor does not record one")
	})
})
