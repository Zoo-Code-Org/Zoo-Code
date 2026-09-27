import { fireEvent, render, screen } from "@/utils/test-utils"

import McpView from "../McpView"

const setMcpEnabled = vi.fn()

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		mcpServers: [],
		alwaysAllowMcp: false,
		mcpEnabled: false,
	}),
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/hooks/useTooManyTools", () => ({
	useTooManyTools: () => ({ isOverThreshold: false, title: "", message: "" }),
}))

vi.mock("@src/components/settings/Section", () => ({
	Section: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock("@src/components/settings/SectionHeader", () => ({
	SectionHeader: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
		<button onClick={onClick}>{children}</button>
	),
	Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	ToggleSwitch: () => null,
	StandardTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("../McpEnabledToggle", () => ({
	default: ({
		mcpEnabled,
		setMcpEnabled: setEnabled,
	}: {
		mcpEnabled: boolean
		setMcpEnabled?: (value: boolean) => void
	}) => (
		<button data-testid="mcp-enabled-toggle" onClick={() => setEnabled?.(!mcpEnabled)}>
			{String(mcpEnabled)}
		</button>
	),
}))

describe("McpView", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("uses extension state when no buffered value is provided", () => {
		render(<McpView />)

		expect(screen.getByTestId("mcp-enabled-toggle")).toHaveTextContent("false")
	})

	it("uses and updates the buffered value when controlled", () => {
		render(<McpView mcpEnabled={true} setMcpEnabled={setMcpEnabled} />)

		fireEvent.click(screen.getByTestId("mcp-enabled-toggle"))

		expect(setMcpEnabled).toHaveBeenCalledWith(false)
	})
})
