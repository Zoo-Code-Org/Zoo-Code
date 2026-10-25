import { StrictMode, useMemo } from "react"
import { act, render, screen } from "@testing-library/react"
import { useTranslation } from "react-i18next"

import { ExtensionStateContextProvider, useExtensionState } from "@/context/ExtensionStateContext"

import i18next from "../setup"
import { applyLanguage } from "../language"

// A `useTranslation` consumer that caches its output on `t`, as React Compiler does. Under StrictMode
// its `t` is reset to the first identity, so it only renders the hydrated language if that language is
// applied before the hydrating render.
const TipsLikeConsumer = () => {
	const { t } = useTranslation("chat")
	const label = useMemo(() => t("rooTips.customizableModes.title"), [t])
	return <span data-testid="tips">{label}</span>
}

const HydrationGate = () => {
	const { didHydrateState } = useExtensionState()
	return didHydrateState ? <TipsLikeConsumer /> : null
}

const postState = (state: Record<string, unknown>) =>
	act(async () => {
		window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state } }))
	})

describe("hydrated language", () => {
	beforeEach(async () => {
		await i18next.changeLanguage("en")
	})

	it("renders components mounted by hydration in the hydrated language under StrictMode", async () => {
		render(
			<StrictMode>
				<ExtensionStateContextProvider>
					<HydrationGate />
				</ExtensionStateContextProvider>
			</StrictMode>,
		)

		await postState({ language: "es" })

		expect(screen.getByTestId("tips")).toHaveTextContent(
			i18next.t("chat:rooTips.customizableModes.title", { lng: "es" }),
		)
	})
})

describe("applyLanguage", () => {
	beforeEach(async () => {
		await i18next.changeLanguage("en")
	})

	it("switches to a different language", () => {
		applyLanguage(i18next, "es")
		expect(i18next.language).toBe("es")
	})

	it("does not re-emit languageChanged for the active language or a missing one", () => {
		const onChanged = vi.fn()
		i18next.on("languageChanged", onChanged)

		applyLanguage(i18next, "en")
		applyLanguage(i18next, undefined)

		i18next.off("languageChanged", onChanged)
		expect(onChanged).not.toHaveBeenCalled()
	})
})
