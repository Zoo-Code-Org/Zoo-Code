import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

import { act, render, screen } from "@testing-library/react"
import { createInstance } from "i18next"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { providerIdentifiers, type ProviderQuota, type ProviderQuotaWindow } from "@roo-code/types"

import { ProviderLimits } from "../ProviderLimits"

const post = vi.hoisted(() => vi.fn())
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: post } }))

const localesDir = path.resolve(__dirname, "../../../i18n/locales")
const locales = readdirSync(localesDir)
const settingsOf = (locale: string) => JSON.parse(readFileSync(path.join(localesDir, locale, "settings.json"), "utf8"))

// The real translations, as the application loads them (it does not escape values: React already does).
const i18n = createInstance()
const translator = vi.hoisted(() => ({
	t: (key: string, options?: Record<string, unknown>) => `${key}${options ?? ""}`,
}))
vi.mock("@/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: translator.t }) }))

beforeAll(async () => {
	await i18n.init({
		lng: "en",
		fallbackLng: "en",
		interpolation: { escapeValue: false },
		resources: Object.fromEntries(locales.map((locale) => [locale, { settings: settingsOf(locale) }])),
		defaultNS: "settings",
		ns: ["settings"],
	})
	translator.t = (key, options) => i18n.t(key.replace(/^settings:/, ""), { ...options, ns: "settings" })
})

const respond = (windows: ProviderQuotaWindow[]) => {
	const requestId = post.mock.calls
		.map((call) => call[0])
		.filter((message) => message.type === "requestProviderQuotas")
		.at(-1)?.requestId
	const providerQuotas: ProviderQuota[] = [
		{ providerId: providerIdentifiers.openrouter, ok: true, fetchedAt: 1, windows },
	]
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", { data: { type: "providerQuotas", providerQuotas, requestId } }),
		)
	})
}

const rowText = () => screen.getByTestId(`provider-limit-${providerIdentifiers.openrouter}`).textContent

describe("ProviderLimits in another language", () => {
	beforeEach(() => post.mockClear())

	it.each([
		["de", { kind: "left", amount: "$4.25" }, "$4.25 übrig"],
		["de", { kind: "spentMonth", amount: "$3.20" }, "$3.20 diesen Monat ausgegeben"],
		["de", { kind: "spentTotal", amount: "$42.00" }, "$42.00 insgesamt ausgegeben"],
		["de", { kind: "usedOf", used: "$12.40", limit: "$50.00" }, "$12.40 / $50.00 verbraucht"],
		["ja", { kind: "left", amount: "¥8.00" }, "残り ¥8.00"],
		["ja", { kind: "spentMonth", amount: "$3.20" }, "今月の支出 $3.20"],
		["fr", { kind: "left", amount: "$4.25" }, "$4.25 restants"],
		["fr", { kind: "percentUsed", percent: 42 }, "42 % utilisé"],
		["zh-CN", { kind: "spentTotal", amount: "$42.00" }, "累计已花费 $42.00"],
		["ru", { kind: "notReported" }, "Использование не сообщается"],
		[
			"es",
			{ kind: "creditsOf", window: "Weekly", name: { key: "weekly" }, used: "500", total: "2,000" },
			"Semanal: 500 / 2,000 créditos",
		],
		["it", { kind: "windowDegraded", window: "Daily", name: { key: "daily" } }, "Giornaliero (degradato)"],
		[
			"pt-BR",
			{ kind: "windowState", window: "Monthly", name: { key: "monthly" }, state: "grace" },
			"Mensal (grace)",
		],
	] as const)("writes the %s label for %j as %j, not in English", async (locale, value, expected) => {
		await i18n.changeLanguage(locale)
		render(<ProviderLimits />)

		respond([{ id: "w", valueLabel: "ENGLISH FALLBACK", value }])

		expect(rowText()).toContain(expected)
		expect(rowText()).not.toContain("ENGLISH FALLBACK")
		expect(rowText()).not.toContain("settings:") // no key is shown instead of a word
	})

	it("shows the English label of a window that has no data for the figure (an older host)", async () => {
		await i18n.changeLanguage("de")
		render(<ProviderLimits />)

		respond([{ id: "w", valueLabel: "$4.25 left" }])

		expect(rowText()).toContain("$4.25 left")
	})

	it("keeps a window name that has no structured name as the host wrote it", async () => {
		await i18n.changeLanguage("de")
		render(<ProviderLimits />)

		respond([
			{
				id: "w",
				valueLabel: "Daily (grace)",
				value: { kind: "windowState", window: "Daily (x)", state: "grace" },
			},
		])

		expect(rowText()).toContain("Daily (x) (grace)")
	})

	describe("every language that the application has", () => {
		const valueKeys = [
			"usedOf",
			"percentUsed",
			"spentMonth",
			"spentTotal",
			"left",
			"notReported",
			"creditsOf",
			"windowState",
			"windowDegraded",
		]
		const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort()

		it.each(locales)("%s has every figure and window name, with the same placeholders as English", (locale) => {
			const english = settingsOf("en").usage.limits
			const limits = settingsOf(locale).usage.limits

			for (const key of valueKeys) {
				expect(typeof limits.value[key], `${locale} value.${key}`).toBe("string")
				expect(placeholders(limits.value[key]), `${locale} value.${key}`).toEqual(
					placeholders(english.value[key]),
				)
			}
			for (const key of ["credits", "tokens"])
				expect(typeof limits.window[key], `${locale} window.${key}`).toBe("string")
		})
	})
})
