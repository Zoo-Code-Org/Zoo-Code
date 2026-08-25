import { act, render, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import MermaidBlock from "../MermaidBlock"

const mermaidMocks = vi.hoisted(() => ({
	initialize: vi.fn(),
	parse: vi.fn(),
	renderDiagram: vi.fn(),
}))

vi.mock("mermaid", () => ({
	default: {
		initialize: mermaidMocks.initialize,
		parse: mermaidMocks.parse,
		render: mermaidMocks.renderDiagram,
	},
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/utils/clipboard", () => ({
	useCopyToClipboard: () => ({ showCopyFeedback: false, copyWithFeedback: vi.fn() }),
}))

vi.mock("@/components/common/MermaidButton", () => ({
	MermaidButton: ({ children }: { children: React.ReactNode }) => children,
}))

describe("MermaidBlock", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		document.body.className = "vscode-light"
		document.body.dataset.vscodeThemeId = "Default Light Modern"
		document.body.style.setProperty("--vscode-editor-background", "#ffffff")
		document.body.style.setProperty("--vscode-editor-foreground", "#333333")
		document.body.style.setProperty("--vscode-input-background", "#f3f3f3")
		document.body.style.setProperty("--vscode-input-border", "#717171")
		mermaidMocks.parse.mockResolvedValue({ diagramType: "flowchart-v2" })
		mermaidMocks.renderDiagram.mockResolvedValue({ svg: '<svg data-testid="rendered-diagram"></svg>' })
	})

	it("rerenders an existing diagram when the host theme changes", async () => {
		const { getByTestId } = render(<MermaidBlock code="graph TD; A-->B" />)

		await waitFor(() => expect(mermaidMocks.renderDiagram).toHaveBeenCalledTimes(1), { timeout: 1_500 })
		expect(getByTestId("rendered-diagram")).toBeInTheDocument()
		expect(mermaidMocks.initialize).toHaveBeenLastCalledWith(
			expect.objectContaining({ themeVariables: expect.objectContaining({ darkMode: false }) }),
		)

		act(() => {
			document.body.className = "vscode-dark"
			document.body.dataset.vscodeThemeId = "Default Dark Modern"
			document.body.style.setProperty("--vscode-editor-background", "#1e1e1e")
			document.body.style.setProperty("--vscode-editor-foreground", "#d4d4d4")
		})

		await waitFor(() => expect(mermaidMocks.renderDiagram).toHaveBeenCalledTimes(2), { timeout: 1_500 })
		expect(mermaidMocks.initialize).toHaveBeenLastCalledWith(
			expect.objectContaining({ themeVariables: expect.objectContaining({ darkMode: true }) }),
		)
	})

	it("does not replace the current theme with a stale render", async () => {
		let resolveFirstRender!: (value: { svg: string }) => void
		mermaidMocks.renderDiagram
			.mockImplementationOnce(() => new Promise((resolve) => (resolveFirstRender = resolve)))
			.mockResolvedValueOnce({ svg: '<svg data-testid="dark-diagram"></svg>' })
		const { queryByTestId } = render(<MermaidBlock code="graph TD; A-->B" />)

		await waitFor(() => expect(mermaidMocks.renderDiagram).toHaveBeenCalledTimes(1), { timeout: 1_500 })
		act(() => {
			document.body.className = "vscode-dark"
			document.body.dataset.vscodeThemeId = "Default Dark Modern"
			document.body.style.setProperty("--vscode-editor-background", "#1e1e1e")
			document.body.style.setProperty("--vscode-editor-foreground", "#d4d4d4")
		})

		await waitFor(() => expect(mermaidMocks.renderDiagram).toHaveBeenCalledTimes(2), { timeout: 1_500 })
		await waitFor(() => expect(queryByTestId("dark-diagram")).toBeInTheDocument())
		await act(async () => resolveFirstRender({ svg: '<svg data-testid="stale-light-diagram"></svg>' }))

		expect(queryByTestId("dark-diagram")).toBeInTheDocument()
		expect(queryByTestId("stale-light-diagram")).not.toBeInTheDocument()
	})
})
