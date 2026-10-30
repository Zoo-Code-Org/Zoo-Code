import { act, render, screen, waitFor } from "@testing-library/react"
import React from "react"

import i18next from "../setup"
import TranslationProvider, { useAppTranslation } from "../TranslationContext"

// The provider reads the active language from extension state. Tests drive it
// through a mutable holder so a rerender can simulate a settings change.
const extensionState: { language: string } = { language: "en" }

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => extensionState,
}))

const Probe = () => {
	const { t, i18n } = useAppTranslation()

	return (
		<div>
			<span data-testid="error-title">{t("common:errorBoundary.title")}</span>
			<span data-testid="active-language">{i18n.language}</span>
		</div>
	)
}

const renderProbe = (language: string) => {
	extensionState.language = language

	return render(
		<TranslationProvider>
			<Probe />
		</TranslationProvider>,
	)
}

describe("TranslationProvider locale loading", () => {
	beforeEach(async () => {
		// i18next is a module-level singleton, so a language left active by an
		// earlier test would mask the fallback path this suite is checking.
		await i18next.changeLanguage("en")
	})

	it("renders translated strings for a non-English initial language", async () => {
		renderProbe("ko")

		// Korean bundles are not in the entry chunk, so the first paint resolves
		// through the English fallback and the switch lands after the fetch.
		await waitFor(() => {
			expect(screen.getByTestId("error-title")).toHaveTextContent("문제가 발생했습니다")
		})
		expect(screen.getByTestId("active-language")).toHaveTextContent("ko")
	})

	it("loads a non-eager locale when the language changes at runtime", async () => {
		const { rerender } = renderProbe("en")

		expect(screen.getByTestId("error-title")).toHaveTextContent("Something went wrong")

		extensionState.language = "ja"
		await act(async () => {
			rerender(
				<TranslationProvider>
					<Probe />
				</TranslationProvider>,
			)
		})

		await waitFor(() => {
			expect(screen.getByTestId("error-title")).toHaveTextContent("問題が発生しました")
		})
		expect(screen.getByTestId("active-language")).toHaveTextContent("ja")
	})

	it("falls back to English when the requested locale has no resources", async () => {
		renderProbe("xx-unsupported")

		await waitFor(() => {
			expect(screen.getByTestId("error-title")).toHaveTextContent("Something went wrong")
		})
	})

	it("keeps English available after switching away and back", async () => {
		const { rerender } = renderProbe("de")

		await waitFor(() => {
			expect(screen.getByTestId("error-title")).toHaveTextContent("Etwas ist schiefgelaufen")
		})

		extensionState.language = "en"
		await act(async () => {
			rerender(
				<TranslationProvider>
					<Probe />
				</TranslationProvider>,
			)
		})

		await waitFor(() => {
			expect(screen.getByTestId("error-title")).toHaveTextContent("Something went wrong")
		})
	})
})
