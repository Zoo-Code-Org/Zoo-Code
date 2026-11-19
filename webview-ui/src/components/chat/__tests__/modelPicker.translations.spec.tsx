import i18next from "i18next"
import { render, screen } from "@testing-library/react"

import english from "@src/i18n/locales/en/chat.json"
import russian from "@src/i18n/locales/ru/chat.json"
import { TranslationContext } from "@src/i18n/TranslationContext"
import { PickerSearchField } from "../PickerSearchField"

const locales = import.meta.glob<{ modelPicker: typeof english.modelPicker }>("../../../i18n/locales/*/chat.json", {
	eager: true,
	import: "default",
})

describe("model picker translations", () => {
	it("provides every new label and effort level in all 18 locales", () => {
		expect(Object.keys(locales)).toHaveLength(18)
		for (const locale of Object.values(locales)) {
			expect(Object.keys(locale.modelPicker).sort()).toEqual(Object.keys(english.modelPicker).sort())
			expect(Object.keys(locale.modelPicker.effort).sort()).toEqual(
				Object.keys(english.modelPicker.effort).sort(),
			)
			expect(locale.modelPicker.reasoningEffortValue).toContain("{{effort}}")
			for (const value of Object.values(locale.modelPicker)) {
				if (typeof value === "string") expect(value.trim()).not.toBe("")
			}
		}
	})

	it.each([
		["en", "Clear search"],
		["ru", "Очистить поиск"],
	])("renders the search controls using the %s locale", async (language, clearLabel) => {
		const instance = i18next.createInstance()
		await instance.init({
			lng: language,
			fallbackLng: "en",
			resources: { en: { chat: english }, ru: { chat: russian } },
		})
		render(
			<TranslationContext.Provider value={{ t: instance.getFixedT(language), language }}>
				<PickerSearchField
					label={instance.t("chat:modelPicker.searchModels")}
					value="query"
					onChange={vi.fn()}
				/>
			</TranslationContext.Provider>,
		)
		expect(screen.getByRole("button", { name: clearLabel })).toBeInTheDocument()
		expect(screen.getByRole("textbox")).toHaveAccessibleName(instance.t("chat:modelPicker.searchModels"))
		expect(
			instance.t("chat:modelPicker.reasoningEffortValue", { effort: instance.t("chat:modelPicker.effort.high") }),
		).not.toContain("{{")
	})
})
