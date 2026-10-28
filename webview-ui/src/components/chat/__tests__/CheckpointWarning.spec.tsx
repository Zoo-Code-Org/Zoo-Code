// pnpm --filter @roo-code/vscode-webview test src/components/chat/__tests__/CheckpointWarning.spec.tsx

import { act, fireEvent, render, screen } from "@testing-library/react"

import i18next from "@src/i18n/setup"

import { CheckpointWarning } from "../CheckpointWarning"

describe("CheckpointWarning", () => {
	beforeEach(async () => {
		await i18next.changeLanguage("en")
	})

	it.each([
		["WAIT_TIMEOUT", "Waited 15 seconds for checkpoint initialization."],
		["INIT_TIMEOUT", "Checkpoint initialization has taken more than 15 seconds"],
	] as const)("renders the %s message with the timeout", (type, expected) => {
		render(<CheckpointWarning warning={{ type, timeout: 15 }} />)

		expect(screen.getByText(expected, { exact: false })).toBeInTheDocument()
	})

	it("opens the checkpoint settings from the inline link", () => {
		const postMessage = vi.spyOn(window, "postMessage")
		render(<CheckpointWarning warning={{ type: "WAIT_TIMEOUT", timeout: 15 }} />)

		fireEvent.click(screen.getByText("the checkpoint settings"))

		expect(postMessage).toHaveBeenCalledWith(
			{ type: "action", action: "settingsButtonClicked", values: { section: "checkpoints" } },
			"*",
		)
		postMessage.mockRestore()
	})

	it("follows a UI language change without remounting", async () => {
		render(<CheckpointWarning warning={{ type: "WAIT_TIMEOUT", timeout: 15 }} />)

		await act(async () => {
			await i18next.changeLanguage("es")
		})

		expect(screen.getByText("Has esperado 15 segundos", { exact: false })).toBeInTheDocument()
		expect(screen.getByText("la configuración del punto de control")).toBeInTheDocument()
	})
})
