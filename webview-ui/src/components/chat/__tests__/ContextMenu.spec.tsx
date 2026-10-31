// pnpm --filter @roo-code/vscode-webview test src/components/chat/__tests__/ContextMenu.spec.tsx

import { act, fireEvent, render, screen } from "@testing-library/react"

import type { Command } from "@roo-code/types"

import i18next from "@src/i18n/setup"
import { ContextMenuOptionType } from "@src/utils/context-mentions"
import { vscode } from "@src/utils/vscode"

import ContextMenu from "../ContextMenu"

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

const commands: Command[] = [{ name: "review", source: "project", description: "Review the diff" }]

const renderMenu = (props: Partial<React.ComponentProps<typeof ContextMenu>> = {}) => {
	const onSelect = vi.fn()
	const setSelectedIndex = vi.fn()
	render(
		<ContextMenu
			onSelect={onSelect}
			searchQuery=""
			inputValue=""
			onMouseDown={() => {}}
			selectedIndex={0}
			setSelectedIndex={setSelectedIndex}
			selectedType={null}
			queryItems={[]}
			{...props}
		/>,
	)
	return { onSelect, setSelectedIndex }
}

describe("ContextMenu", () => {
	beforeEach(async () => {
		vi.mocked(vscode.postMessage).mockClear()
		await i18next.changeLanguage("en")
	})

	it("renders the default mention options with translated labels", () => {
		renderMenu()

		expect(screen.getByText("Problems")).toBeInTheDocument()
		expect(screen.getByText("Terminal")).toBeInTheDocument()
		expect(screen.getByText("Paste URL to fetch contents")).toBeInTheDocument()
		expect(screen.getByText("Add Folder")).toBeInTheDocument()
		expect(screen.getByText("Add File")).toBeInTheDocument()
		expect(screen.getByText("Git Commits")).toBeInTheDocument()
	})

	it("selects selectable options and ignores the URL hint", () => {
		const { onSelect, setSelectedIndex } = renderMenu()

		fireEvent.mouseEnter(screen.getByText("Terminal"))
		fireEvent.click(screen.getByText("Terminal"))
		fireEvent.click(screen.getByText("Paste URL to fetch contents"))

		expect(setSelectedIndex).toHaveBeenCalledWith(1)
		expect(onSelect).toHaveBeenCalledTimes(1)
		expect(onSelect).toHaveBeenCalledWith(ContextMenuOptionType.Terminal, undefined)
	})

	it("renders file paths split into name and folder", () => {
		renderMenu({
			selectedType: ContextMenuOptionType.File,
			queryItems: [{ type: ContextMenuOptionType.File, value: "/src/components/App.tsx" }],
		})

		expect(screen.getByText("App.tsx")).toBeInTheDocument()
		expect(screen.getByText("src/components")).toBeInTheDocument()
	})

	it("shows the no-results row when nothing matches", () => {
		renderMenu({ selectedType: ContextMenuOptionType.Folder })

		expect(screen.getByText("No results")).toBeInTheDocument()
	})

	it("renders slash commands with the description and a settings shortcut", () => {
		const { onSelect } = renderMenu({ searchQuery: "/", commands })

		expect(screen.getByText("/review")).toBeInTheDocument()
		expect(screen.getByText("Review the diff")).toBeInTheDocument()
		expect(screen.getByText(/Slash commands are shortcuts/)).toBeInTheDocument()
		expect(screen.getByRole("link", { name: "Learn more" })).toBeInTheDocument()

		fireEvent.click(screen.getByText("/review"))
		expect(onSelect).toHaveBeenCalledWith(ContextMenuOptionType.Command, "review")

		fireEvent.click(screen.getByTitle("Manage slash commands in settings"))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "switchTab",
			tab: "settings",
			values: { section: "slashCommands" },
		})
	})

	it("follows a UI language change without remounting", async () => {
		renderMenu({ searchQuery: "/", commands })

		await act(async () => {
			await i18next.changeLanguage("es")
		})

		expect(screen.getByText(/Gestiona tus comandos de barra/)).toBeInTheDocument()
		expect(screen.getByTitle("Administrar comandos de barra en la configuración")).toBeInTheDocument()
	})

	it("relabels the default options after a language change", async () => {
		renderMenu()

		await act(async () => {
			await i18next.changeLanguage("es")
		})

		expect(screen.getByText("Problemas")).toBeInTheDocument()
		expect(screen.getByText("Pega la URL para obtener el contenido")).toBeInTheDocument()
	})
})
