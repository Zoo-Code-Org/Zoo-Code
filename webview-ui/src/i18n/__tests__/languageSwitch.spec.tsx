import { memo, useMemo } from "react"
import { act, render, renderHook, screen, waitFor } from "@testing-library/react"
import { Trans, useTranslation } from "react-i18next"

import { ExtensionStateContextProvider } from "@/context/ExtensionStateContext"

import i18next from "../setup"

const postState = (state: Record<string, unknown>) =>
	act(async () => {
		window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state } }))
	})

// React Compiler (enabled in vite.config.ts, not in Vitest) caches render output and only
// recomputes it when a dependency changes. These consumers reproduce that caching by hand:
// a stale value here is exactly what the compiled webview showed on the Welcome page.

const PlainConsumer = memo(function PlainConsumer() {
	const { t } = useTranslation()
	const label = useMemo(() => t("history:recentTasks"), [t])
	return <span data-testid="plain">{label}</span>
})

const NamespacedConsumer = memo(function NamespacedConsumer() {
	const { t } = useTranslation("chat")
	const label = useMemo(() => t("rooTips.customizableModes.title"), [t])
	return <span data-testid="namespaced">{label}</span>
})

const TransConsumer = memo(function TransConsumer() {
	const { t } = useTranslation()
	// The compiler caches `<Trans>` like this; passing `t` makes the element depend on the language.
	const element = useMemo(() => <Trans t={t} i18nKey="chat:about" />, [t])
	return <span data-testid="trans">{element}</span>
})

describe("language switch without remounting", () => {
	beforeEach(async () => {
		await i18next.changeLanguage("en")
	})

	it("updates plain and namespaced useTranslation and Trans consumers from en to es", async () => {
		render(
			<ExtensionStateContextProvider>
				<PlainConsumer />
				<NamespacedConsumer />
				<TransConsumer />
			</ExtensionStateContextProvider>,
		)

		expect(screen.getByTestId("plain")).toHaveTextContent("Recent Tasks")
		expect(screen.getByTestId("namespaced")).toHaveTextContent(
			i18next.t("chat:rooTips.customizableModes.title", { lng: "en" }),
		)
		expect(screen.getByTestId("trans")).toHaveTextContent("Zoo is a whole AI dev team in your editor")

		await postState({ language: "es" })

		await waitFor(() => expect(screen.getByTestId("plain")).toHaveTextContent("Tareas"))
		expect(screen.getByTestId("namespaced")).toHaveTextContent(
			i18next.t("chat:rooTips.customizableModes.title", { lng: "es" }),
		)
		expect(screen.getByTestId("trans")).toHaveTextContent(i18next.t("chat:about", { lng: "es" }))
	})

	it("keeps t stable across re-renders while the language is unchanged", () => {
		const { result, rerender } = renderHook(() => useTranslation("chat").t)
		const first = result.current

		rerender()

		expect(result.current).toBe(first)
	})

	it("translates fully qualified keys with a namespaced t", () => {
		const Qualified = () => {
			const { t } = useTranslation("chat")
			return <span data-testid="qualified">{t("history:recentTasks")}</span>
		}

		render(<Qualified />)

		expect(screen.getByTestId("qualified")).toHaveTextContent("Recent Tasks")
	})
})
