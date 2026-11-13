import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { LanguageSettings } from "../LanguageSettings"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

// Radix Select does not open in jsdom; a native <select> exercises the same handlers.
vi.mock("@src/components/ui", () => ({
	Select: ({
		value,
		onValueChange,
		children,
	}: {
		value: string
		onValueChange: (v: string) => void
		children: React.ReactNode
	}) => (
		<select data-testid={`select-${value}`} value={value} onChange={(e) => onValueChange(e.target.value)}>
			{children}
		</select>
	),
	SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	SelectValue: () => null,
	SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	SelectGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
		<option value={value}>{children}</option>
	),
}))

describe("LanguageSettings – select handlers", () => {
	it("saves the chosen display language", () => {
		const setCachedStateField = vi.fn()
		render(<LanguageSettings language="en" setCachedStateField={setCachedStateField} />)
		fireEvent.change(screen.getByTestId("select-en"), { target: { value: "fr" } })
		expect(setCachedStateField).toHaveBeenCalledWith("language", "fr")
	})

	it("saves the chosen date order", () => {
		const setCachedStateField = vi.fn()
		render(<LanguageSettings language="en" dateFormat="auto" setCachedStateField={setCachedStateField} />)
		fireEvent.change(screen.getByTestId("select-auto"), { target: { value: "ymd" } })
		expect(setCachedStateField).toHaveBeenCalledWith("dateFormat", "ymd")
	})
})
