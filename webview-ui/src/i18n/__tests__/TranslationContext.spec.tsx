import { memo, useMemo } from "react"
import { Trans } from "react-i18next"
import type { TFunction } from "i18next"
import { renderHook, screen } from "@testing-library/react"

import { renderTranslated } from "./renderTranslated"

import i18next from "../setup"
import { useAppTranslation } from "../TranslationContext"

// React Compiler (enabled in vite.config.ts, not in Vitest) caches render output and only recomputes
// it when a dependency changes. These consumers reproduce that caching by hand: a stale value here is
// exactly what the compiled webview showed after a language switch.
const MemoizedConsumer = memo(function MemoizedConsumer() {
	const { t, language } = useAppTranslation()
	const label = useMemo(() => t("history:recentTasks"), [t])
	const element = useMemo(() => <Trans t={t} i18nKey="chat:about" />, [t])

	return (
		<div>
			<span data-testid="label">{label}</span>
			<span data-testid="trans">{element}</span>
			<span data-testid="interpolated">{t("common:time_ago.days_ago", { count: 3 })}</span>
			<span data-testid="language">{language}</span>
		</div>
	)
})

describe("TranslationProvider", () => {
	beforeEach(async () => {
		await i18next.changeLanguage("en")
	})

	it("provides translations with interpolation and the active language", () => {
		renderTranslated(<MemoizedConsumer />)

		expect(screen.getByTestId("label")).toHaveTextContent("Recent Tasks")
		expect(screen.getByTestId("trans")).toHaveTextContent("Zoo is a whole AI dev team in your editor")
		expect(screen.getByTestId("interpolated")).toHaveTextContent("3 days ago")
		expect(screen.getByTestId("language")).toHaveTextContent("en")
	})

	it("updates memoized consumers and Trans on a language switch without remounting", async () => {
		const { setLanguage } = renderTranslated(<MemoizedConsumer />)

		await setLanguage("es")

		expect(screen.getByTestId("label")).toHaveTextContent("Tareas")
		// eslint-disable-next-line no-restricted-syntax -- expected text computed outside React; nothing is memoized
		expect(screen.getByTestId("trans")).toHaveTextContent(i18next.t("chat:about", { lng: "es" }))
		expect(screen.getByTestId("language")).toHaveTextContent("es")
	})

	it("keeps t stable while the language is unchanged and replaces it on a switch", async () => {
		const seen: TFunction[] = []
		const Probe = () => {
			seen.push(useAppTranslation().t)
			return null
		}
		const { rerender, setLanguage } = renderTranslated(<Probe />)

		rerender(<Probe />)
		expect(seen.length).toBeGreaterThan(1)
		expect(new Set(seen).size).toBe(1)

		await setLanguage("es")
		expect(seen.at(-1)).not.toBe(seen[0])
	})

	it("renders keys as-is without a provider", () => {
		const { result } = renderHook(() => useAppTranslation())

		expect(result.current.t("history:recentTasks")).toBe("history:recentTasks")
		expect(result.current.language).toBe("en")
	})
})
