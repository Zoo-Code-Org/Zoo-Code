import { render, screen, fireEvent, waitFor } from "@/utils/test-utils"

import { vscode } from "@/utils/vscode"

import { CreateRuleDialog } from "../CreateRuleDialog"

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

let mockExtensionState: any = {}

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockExtensionState,
}))

vi.mock("@roo/modes", () => ({
	getAllModes: () => [
		{ slug: "code", name: "Code" },
		{ slug: "architect", name: "Architect" },
	],
}))

vi.mock("@/components/ui", () => ({
	Button: ({ children, onClick, disabled, variant }: any) => (
		<button onClick={onClick} disabled={disabled} data-variant={variant} data-testid="button">
			{children}
		</button>
	),
	Input: ({ value, onChange, placeholder, id, type, className, ...props }: any) => (
		<input
			type={type || "text"}
			value={value}
			onChange={onChange}
			placeholder={placeholder}
			id={id}
			className={className}
			{...props}
		/>
	),
	Dialog: ({ children, open, onOpenChange }: any) => (
		<div data-testid="dialog" data-open={open}>
			<button data-testid="dialog-close" onClick={() => onOpenChange?.(false)}>
				close
			</button>
			{open && children}
		</div>
	),
	DialogContent: ({ children }: any) => <div data-testid="dialog-content">{children}</div>,
	DialogHeader: ({ children }: any) => <div data-testid="dialog-header">{children}</div>,
	DialogTitle: ({ children }: any) => <div data-testid="dialog-title">{children}</div>,
	DialogDescription: ({ children }: any) => <div data-testid="dialog-description">{children}</div>,
	DialogFooter: ({ children }: any) => <div data-testid="dialog-footer">{children}</div>,
	Select: ({ children, value, onValueChange }: any) => (
		<div data-testid="select" data-value={value}>
			{children}
			<button data-testid={`select-set-global`} onClick={() => onValueChange?.("global")}>
				global
			</button>
			<button data-testid={`select-set-project`} onClick={() => onValueChange?.("project")}>
				project
			</button>
			<button data-testid={`select-set-generic`} onClick={() => onValueChange?.("generic")}>
				generic
			</button>
			<button data-testid={`select-set-mode`} onClick={() => onValueChange?.("mode")}>
				mode
			</button>
			<button data-testid={`select-set-code`} onClick={() => onValueChange?.("code")}>
				code
			</button>
		</div>
	),
	SelectTrigger: ({ children }: any) => <div data-testid="select-trigger">{children}</div>,
	SelectValue: ({ placeholder }: any) => <span data-testid="select-value">{placeholder}</span>,
	SelectContent: ({ children }: any) => <div data-testid="select-content">{children}</div>,
	SelectItem: ({ children, value }: any) => (
		<div data-testid={`select-item-${value}`} data-value={value}>
			{children}
		</div>
	),
}))

describe("CreateRuleDialog", () => {
	const mockOnOpenChange = vi.fn()
	const mockOnRuleCreated = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
		mockExtensionState = { customModes: [] }
	})

	it("defaults to workspace when workspace exists", () => {
		render(
			<CreateRuleDialog
				open={true}
				onOpenChange={mockOnOpenChange}
				onRuleCreated={mockOnRuleCreated}
				hasWorkspace={true}
			/>,
		)

		expect(screen.getAllByTestId("select")[0]).toHaveAttribute("data-value", "project")
	})

	it("defaults to global when no workspace exists", () => {
		render(
			<CreateRuleDialog
				open={true}
				onOpenChange={mockOnOpenChange}
				onRuleCreated={mockOnRuleCreated}
				hasWorkspace={false}
			/>,
		)

		expect(screen.getAllByTestId("select")[0]).toHaveAttribute("data-value", "global")
	})

	it("validates name and strips invalid characters", () => {
		render(
			<CreateRuleDialog
				open={true}
				onOpenChange={mockOnOpenChange}
				onRuleCreated={mockOnRuleCreated}
				hasWorkspace={true}
			/>,
		)

		const nameInput = screen.getByPlaceholderText("settings:rules.createDialog.namePlaceholder") as HTMLInputElement
		fireEvent.change(nameInput, { target: { value: "My Rule!_123" } })

		expect(nameInput.value).toBe("myrule_123")
	})

	it("clears the selected mode when switching back to generic rules", async () => {
		render(
			<CreateRuleDialog
				open={true}
				onOpenChange={mockOnOpenChange}
				onRuleCreated={mockOnRuleCreated}
				hasWorkspace={true}
			/>,
		)

		fireEvent.change(screen.getByPlaceholderText("settings:rules.createDialog.namePlaceholder"), {
			target: { value: "mode-rule" },
		})
		fireEvent.click(screen.getAllByTestId("select-set-mode")[1])
		fireEvent.click(screen.getAllByTestId("select-set-code").at(-1)!)
		fireEvent.click(screen.getAllByTestId("select-set-generic")[1])
		fireEvent.click(screen.getByText("settings:rules.createDialog.create"))

		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "createRule",
				values: {
					scope: "project",
					kind: "generic",
					modeSlug: undefined,
					fileName: "mode-rule.md",
				},
			})
		})
	})

	it("requires mode selection for mode-specific rules", () => {
		render(
			<CreateRuleDialog
				open={true}
				onOpenChange={mockOnOpenChange}
				onRuleCreated={mockOnRuleCreated}
				hasWorkspace={true}
			/>,
		)

		fireEvent.change(screen.getByPlaceholderText("settings:rules.createDialog.namePlaceholder"), {
			target: { value: "mode-rule" },
		})
		fireEvent.click(screen.getAllByTestId("select-set-mode")[1])

		expect(screen.getByText("settings:rules.createDialog.modeLabel")).toBeInTheDocument()
		expect(screen.getByText("settings:rules.createDialog.create").closest("button")).toBeDisabled()
	})

	it("appends .md and sends createRule with selected values", async () => {
		render(
			<CreateRuleDialog
				open={true}
				onOpenChange={mockOnOpenChange}
				onRuleCreated={mockOnRuleCreated}
				hasWorkspace={true}
			/>,
		)

		fireEvent.change(screen.getByPlaceholderText("settings:rules.createDialog.namePlaceholder"), {
			target: { value: "code-rule" },
		})
		fireEvent.click(screen.getAllByTestId("select-set-mode")[1])
		fireEvent.click(screen.getAllByTestId("select-set-code").at(-1)!)
		fireEvent.click(screen.getByText("settings:rules.createDialog.create"))

		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "createRule",
				values: {
					scope: "project",
					kind: "mode",
					modeSlug: "code",
					fileName: "code-rule.md",
				},
			})
		})
		expect(mockOnRuleCreated).toHaveBeenCalled()
		expect(mockOnOpenChange).toHaveBeenCalledWith(false)
	})
	it("resets form state when closed through dialog onOpenChange", () => {
		const { rerender } = render(
			<CreateRuleDialog
				open={true}
				onOpenChange={mockOnOpenChange}
				onRuleCreated={mockOnRuleCreated}
				hasWorkspace={true}
			/>,
		)

		const nameInput = screen.getByPlaceholderText("settings:rules.createDialog.namePlaceholder") as HTMLInputElement
		fireEvent.change(nameInput, { target: { value: "stale-rule" } })
		expect(nameInput.value).toBe("stale-rule")

		fireEvent.click(screen.getByTestId("dialog-close"))
		expect(mockOnOpenChange).toHaveBeenCalledWith(false)

		rerender(
			<CreateRuleDialog
				open={true}
				onOpenChange={mockOnOpenChange}
				onRuleCreated={mockOnRuleCreated}
				hasWorkspace={true}
			/>,
		)

		expect(screen.getByPlaceholderText("settings:rules.createDialog.namePlaceholder")).toHaveValue("")
	})
})
