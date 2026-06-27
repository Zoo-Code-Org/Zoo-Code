import { render, screen, fireEvent, waitFor } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import type { RuleMetadata } from "@roo-code/types"

import { ExtensionStateContextProvider } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"

import { RulesSettings } from "../RulesSettings"

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, params?: any) =>
			params?.mode ? `${key} ${params.mode}` : params?.name ? `${key} ${params.name}` : key,
	}),
}))

vi.mock("@/components/ui", () => ({
	AlertDialog: ({ children, open }: any) => (
		<div data-testid="alert-dialog" data-open={open}>
			{open && children}
		</div>
	),
	AlertDialogContent: ({ children }: any) => <div data-testid="alert-dialog-content">{children}</div>,
	AlertDialogHeader: ({ children }: any) => <div data-testid="alert-dialog-header">{children}</div>,
	AlertDialogTitle: ({ children }: any) => <div data-testid="alert-dialog-title">{children}</div>,
	AlertDialogDescription: ({ children }: any) => <div data-testid="alert-dialog-description">{children}</div>,
	AlertDialogFooter: ({ children }: any) => <div data-testid="alert-dialog-footer">{children}</div>,
	AlertDialogAction: ({ children, onClick }: any) => (
		<button data-testid="alert-dialog-action" onClick={onClick}>
			{children}
		</button>
	),
	AlertDialogCancel: ({ children, onClick }: any) => (
		<button data-testid="alert-dialog-cancel" onClick={onClick}>
			{children}
		</button>
	),
	Button: ({ children, onClick, disabled, className, variant, size }: any) => (
		<button
			onClick={onClick}
			disabled={disabled}
			className={className}
			data-variant={variant}
			data-size={size}
			data-testid="button">
			{children}
		</button>
	),
	StandardTooltip: ({ children }: any) => <>{children}</>,
}))

vi.mock("../CreateRuleDialog", () => ({
	CreateRuleDialog: ({ open, onOpenChange, onRuleCreated }: any) => (
		<div data-testid="create-rule-dialog" data-open={open}>
			{open && (
				<>
					<button onClick={() => onOpenChange(false)} data-testid="close-dialog">
						Close
					</button>
					<button onClick={onRuleCreated} data-testid="create-rule-button">
						Create
					</button>
				</>
			)}
		</div>
	),
}))

vi.mock("../SectionHeader", () => ({
	SectionHeader: ({ children }: any) => <div data-testid="section-header">{children}</div>,
}))

const mockRules: RuleMetadata[] = [
	{
		id: "project:generic:generic:workspace-rule.md",
		name: "workspace-rule.md",
		scope: "project",
		kind: "generic",
		filePath: "/workspace/.roo/rules/workspace-rule.md",
		relativePath: "workspace-rule.md",
		directoryPath: "/workspace/.roo/rules",
	},
	{
		id: "global:mode:code:global-code.md",
		name: "global-code.md",
		scope: "global",
		kind: "mode",
		modeSlug: "code",
		modeName: "Code",
		filePath: "/home/.roo/rules-code/global-code.md",
		relativePath: "global-code.md",
		directoryPath: "/home/.roo/rules-code",
	},
]

let mockExtensionState: any = {}

vi.mock("@/context/ExtensionStateContext", () => ({
	ExtensionStateContextProvider: ({ children }: any) => children,
	useExtensionState: () => mockExtensionState,
}))

const renderRulesSettings = (rules: RuleMetadata[] = mockRules, cwd?: string) => {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	})

	mockExtensionState = {
		rules,
		cwd: cwd !== undefined ? cwd : "/workspace",
	}

	return render(
		<QueryClientProvider client={queryClient}>
			<ExtensionStateContextProvider>
				<RulesSettings />
			</ExtensionStateContextProvider>
		</QueryClientProvider>,
	)
}

describe("RulesSettings", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders section header", () => {
		renderRulesSettings()

		expect(screen.getByTestId("section-header")).toBeInTheDocument()
		expect(screen.getByText("settings:sections.rules")).toBeInTheDocument()
	})

	it("requests rules on mount", () => {
		renderRulesSettings()

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "requestRules" })
	})

	it("shows workspace section only when cwd is present", () => {
		renderRulesSettings(mockRules, "")

		expect(screen.queryByText("settings:rules.workspaceRules")).not.toBeInTheDocument()
		expect(screen.getByText("settings:rules.globalRules")).toBeInTheDocument()
	})

	it("groups rules by scope and renders kind labels", () => {
		renderRulesSettings()

		expect(screen.getByText("settings:rules.workspaceRules")).toBeInTheDocument()
		expect(screen.getByText("settings:rules.globalRules")).toBeInTheDocument()
		expect(screen.getAllByText("workspace-rule.md").length).toBeGreaterThan(0)
		expect(screen.getAllByText("global-code.md").length).toBeGreaterThan(0)
		expect(screen.getByText("settings:rules.kind.genericBadge")).toBeInTheDocument()
		expect(screen.getByText("settings:rules.kind.modeBadge")).toBeInTheDocument()
		expect(screen.getByText("settings:rules.modeLabel Code")).toBeInTheDocument()
	})

	it("opens create dialog from Add Rule", () => {
		renderRulesSettings()

		fireEvent.click(screen.getByText("settings:rules.addRule").closest("button")!)

		expect(screen.getByTestId("create-rule-dialog")).toHaveAttribute("data-open", "true")
	})

	it("sends openRuleFile on edit", () => {
		renderRulesSettings()
		vi.clearAllMocks()

		const editButtons = screen
			.getAllByTestId("button")
			.filter(
				(button) => button.getAttribute("data-size") === "icon" && !button.querySelector(".text-destructive"),
			)
		fireEvent.click(editButtons[0])

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "openRuleFile",
			values: expect.objectContaining({
				scope: "project",
				kind: "generic",
				relativePath: "workspace-rule.md",
			}),
		})
	})

	it("opens delete confirmation and sends deleteRule", async () => {
		renderRulesSettings()
		vi.clearAllMocks()

		const deleteButtons = screen
			.getAllByTestId("button")
			.filter((button) => button.querySelector(".text-destructive"))
		fireEvent.click(deleteButtons[0])

		expect(screen.getByTestId("alert-dialog")).toHaveAttribute("data-open", "true")

		fireEvent.click(screen.getByTestId("alert-dialog-action"))

		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "deleteRule",
				values: expect.objectContaining({
					scope: "project",
					kind: "generic",
					relativePath: "workspace-rule.md",
				}),
			})
		})
	})

	it("does not manually refresh after create/delete", () => {
		renderRulesSettings()
		fireEvent.click(screen.getByText("settings:rules.addRule").closest("button")!)
		fireEvent.click(screen.getByTestId("create-rule-button"))

		const requestCalls = (vscode.postMessage as any).mock.calls.filter(
			(call: any) => call[0].type === "requestRules",
		)
		expect(requestCalls).toHaveLength(1)
	})
})
