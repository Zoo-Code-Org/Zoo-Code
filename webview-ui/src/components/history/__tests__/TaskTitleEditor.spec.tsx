import { render, screen, fireEvent } from "@/utils/test-utils"

import { vscode } from "@src/utils/vscode"

import { TaskTitleEditor } from "../TaskTitleEditor"

vi.mock("@src/utils/vscode")

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

const renderEditor = (title?: string) => {
	const onDone = vi.fn()
	render(<TaskTitleEditor item={{ id: "task-1", task: "Original prompt", title }} onDone={onDone} />)
	return { input: screen.getByTestId("task-title-input"), onDone }
}

const submit = (input: HTMLElement, value: string) => {
	fireEvent.change(input, { target: { value } })
	fireEvent.keyDown(input, { key: "Enter" })
}

describe("TaskTitleEditor", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it.each([
		["the original prompt when there is no title", undefined, "Original prompt"],
		["the current title when renamed", "Custom", "Custom"],
	])("starts with %s", (_label, title, expected) => {
		const { input } = renderEditor(title)

		expect(input).toHaveValue(expected)
	})

	it("sends the trimmed title on Enter", () => {
		const { input, onDone } = renderEditor()

		submit(input, "  New name ")

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "renameTaskWithId",
			taskId: "task-1",
			text: "New name",
		})
		expect(onDone).toHaveBeenCalled()
	})

	it.each([
		["a blank value", "   "],
		["the original prompt", "Original prompt"],
	])("clears an existing title when saving %s", (_label, value) => {
		const { input } = renderEditor("Custom")

		submit(input, value)

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "renameTaskWithId", taskId: "task-1", text: "" })
	})

	it.each([
		["the title is unchanged", "Custom", "Custom"],
		["an untitled task is saved blank", undefined, ""],
	])("does not send a message when %s", (_label, title, value) => {
		const { input, onDone } = renderEditor(title)

		submit(input, value)

		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(onDone).toHaveBeenCalled()
	})

	it("lets keydown reach window so VS Code can run clipboard shortcuts", () => {
		const onWindowKeyDown = vi.fn()
		window.addEventListener("keydown", onWindowKeyDown)
		try {
			const { input } = renderEditor()

			fireEvent.keyDown(input, { key: "v", metaKey: true })

			expect(onWindowKeyDown).toHaveBeenCalledTimes(1)
		} finally {
			window.removeEventListener("keydown", onWindowKeyDown)
		}
	})

	it.each([
		["Escape", (input: HTMLElement) => fireEvent.keyDown(input, { key: "Escape" })],
		["blur", (input: HTMLElement) => fireEvent.blur(input)],
	])("cancels on %s without saving", (_label, cancel) => {
		const { input, onDone } = renderEditor()

		fireEvent.change(input, { target: { value: "Discarded" } })
		cancel(input)

		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(onDone).toHaveBeenCalled()
	})
})
