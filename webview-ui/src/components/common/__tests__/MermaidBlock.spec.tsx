import { act, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import MermaidBlock from "../MermaidBlock"

const mermaidMocks = vi.hoisted(() => ({
	initialize: vi.fn(),
	parse: vi.fn(),
	renderDiagram: vi.fn(),
}))

// Mermaid is loaded through a dynamic import, so the module factory has to serve the
// same shape the component reads from `import("mermaid").default`.
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

	it("shows the loading placeholder until the diagram renders", async () => {
		let resolveRender!: (value: { svg: string }) => void
		mermaidMocks.renderDiagram.mockImplementationOnce(() => new Promise((resolve) => (resolveRender = resolve)))

		render(<MermaidBlock code="graph TD; A-->B" />)

		expect(screen.getByText("common:mermaid.loading")).toBeInTheDocument()

		await waitFor(() => expect(mermaidMocks.renderDiagram).toHaveBeenCalledTimes(1), { timeout: 1_500 })
		await act(async () => resolveRender({ svg: '<svg data-testid="rendered-diagram"></svg>' }))

		await waitFor(() => expect(screen.queryByText("common:mermaid.loading")).not.toBeInTheDocument())
		expect(screen.getByTestId("rendered-diagram")).toBeInTheDocument()
	})

	it("renders the error state when the mermaid chunk fails to load", async () => {
		vi.resetModules()
		vi.doMock("mermaid", () => {
			throw new Error("Failed to fetch dynamically imported module")
		})
		const { default: FreshMermaidBlock } = await import("../MermaidBlock")
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})

		render(<FreshMermaidBlock code="graph TD; A-->B" />)

		await waitFor(() => expect(screen.getByText("common:mermaid.render_error")).toBeInTheDocument(), {
			timeout: 1_500,
		})
		expect(screen.queryByTestId("rendered-diagram")).not.toBeInTheDocument()
		expect(mermaidMocks.initialize).not.toHaveBeenCalled()
		expect(mermaidMocks.parse).not.toHaveBeenCalled()

		consoleWarn.mockRestore()
		vi.doUnmock("mermaid")
		vi.resetModules()
	})

	it("renders the error state when parse rejects", async () => {
		mermaidMocks.parse.mockRejectedValue(new Error("Parse error on line 1"))
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})

		render(<MermaidBlock code="not a diagram" />)

		await waitFor(() => expect(screen.getByText("common:mermaid.render_error")).toBeInTheDocument(), {
			timeout: 1_500,
		})
		expect(mermaidMocks.renderDiagram).not.toHaveBeenCalled()

		consoleWarn.mockRestore()
	})
})
