import { render, screen, fireEvent, act } from "@testing-library/react"

import { TooltipProvider } from "../../../ui/tooltip"
import { AutocompleteModelPicker } from "../AutocompleteModelPicker"

const postMessage = vi.fn()

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (...a: unknown[]) => postMessage(...(a as [])) } }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

/** Dispatches the extension-host reply the picker listens for. */
function replyWithModels(payload: { models?: { id: string; label?: string }[]; error?: string }) {
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", { data: { type: "autocompleteModels", autocompleteModels: payload } }),
		)
	})
}

const renderPicker = (props: Partial<React.ComponentProps<typeof AutocompleteModelPicker>> = {}) => {
	const onChange = vi.fn()

	const utils = render(
		<TooltipProvider>
			<AutocompleteModelPicker provider="ollama" onChange={onChange} {...props} />
		</TooltipProvider>,
	)

	return { ...utils, onChange }
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
	vi.useRealTimers()
})

describe("AutocompleteModelPicker", () => {
	it("renders a free-text field before any models are known", () => {
		renderPicker()

		expect(screen.getByTestId("autocomplete-model-input")).toBeInTheDocument()
		expect(screen.queryByTestId("autocomplete-model-select")).not.toBeInTheDocument()
	})

	it("propagates a hand-typed model id", () => {
		const { onChange } = renderPicker()

		fireEvent.input(screen.getByTestId("autocomplete-model-input"), { target: { value: "qwen2.5-coder:1.5b" } })

		expect(onChange).toHaveBeenCalledWith("qwen2.5-coder:1.5b")
	})

	it("requests models when the refresh button is clicked", () => {
		renderPicker({ baseUrl: "http://localhost:11434" })

		fireEvent.click(screen.getByTestId("autocomplete-model-refresh"))

		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "requestAutocompleteModels" }))
	})

	it("swaps to a dropdown once models arrive", () => {
		renderPicker({ baseUrl: "http://localhost:11434" })

		replyWithModels({ models: [{ id: "a" }, { id: "b" }] })

		expect(screen.getByTestId("autocomplete-model-select")).toBeInTheDocument()
	})

	it("surfaces an error reply and keeps the free-text field", () => {
		renderPicker({ baseUrl: "http://localhost:11434" })

		replyWithModels({ error: "connection refused" })

		expect(screen.getByTestId("autocomplete-model-error")).toBeInTheDocument()
		expect(screen.getByTestId("autocomplete-model-input")).toBeInTheDocument()
	})

	it("clears a previous error when a later fetch succeeds", () => {
		renderPicker({ baseUrl: "http://localhost:11434" })

		replyWithModels({ error: "connection refused" })
		replyWithModels({ models: [{ id: "a" }] })

		expect(screen.queryByTestId("autocomplete-model-error")).not.toBeInTheDocument()
		expect(screen.getByTestId("autocomplete-model-connected")).toBeInTheDocument()
	})

	it("ignores unrelated window messages", () => {
		renderPicker({ baseUrl: "http://localhost:11434" })

		act(() => {
			window.dispatchEvent(new MessageEvent("message", { data: { type: "somethingElse" } }))
		})

		expect(screen.getByTestId("autocomplete-model-input")).toBeInTheDocument()
	})

	it("auto-fetches after the endpoint settles", () => {
		renderPicker({ baseUrl: "http://localhost:11434" })

		expect(postMessage).not.toHaveBeenCalled()

		act(() => {
			vi.advanceTimersByTime(700)
		})

		expect(postMessage).toHaveBeenCalledTimes(1)
	})

	it("does not auto-fetch while disabled", () => {
		renderPicker({ baseUrl: "http://localhost:11434", disabled: true })

		act(() => {
			vi.advanceTimersByTime(1500)
		})

		expect(postMessage).not.toHaveBeenCalled()
	})

	it("does not auto-fetch without a base URL", () => {
		renderPicker({})

		act(() => {
			vi.advanceTimersByTime(1500)
		})

		expect(postMessage).not.toHaveBeenCalled()
	})

	it("disables the refresh control while a request is in flight", () => {
		renderPicker({ baseUrl: "http://localhost:11434" })

		fireEvent.click(screen.getByTestId("autocomplete-model-refresh"))

		expect(screen.getByTestId("autocomplete-model-refresh")).toBeDisabled()
	})

	it("re-enables refresh once a reply arrives", () => {
		renderPicker({ baseUrl: "http://localhost:11434" })

		fireEvent.click(screen.getByTestId("autocomplete-model-refresh"))
		replyWithModels({ models: [{ id: "a" }] })

		expect(screen.getByTestId("autocomplete-model-refresh")).not.toBeDisabled()
	})

	it("keeps every control disabled when the picker is disabled", () => {
		renderPicker({ disabled: true })

		expect(screen.getByTestId("autocomplete-model-input")).toBeDisabled()
		expect(screen.getByTestId("autocomplete-model-refresh")).toBeDisabled()
	})

	it("still offers a custom field alongside the dropdown", () => {
		// A model the endpoint doesn't list must remain typeable.
		renderPicker({ baseUrl: "http://localhost:11434" })

		replyWithModels({ models: [{ id: "a" }] })

		expect(screen.getByTestId("autocomplete-model-select")).toBeInTheDocument()
		expect(screen.getByTestId("autocomplete-model-input")).toBeInTheDocument()
	})
})
