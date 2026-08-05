import React from "react"

import type { HookDefinition } from "@roo-code/types"

import { fireEvent, render, screen } from "@/utils/test-utils"

import { HooksSettings } from "../HooksSettings"

vi.mock("@/components/ui", () => ({
	Button: ({ children, onClick, disabled, ...props }: any) => (
		<button onClick={onClick} disabled={disabled} {...props}>
			{children}
		</button>
	),
	Checkbox: ({ checked, onCheckedChange, ...props }: any) => (
		<input
			type="checkbox"
			checked={checked}
			onChange={(event) => onCheckedChange(event.target.checked)}
			{...props}
		/>
	),
	Input: (props: any) => <input {...props} />,
	StandardTooltip: ({ children, content }: any) => (
		<div>
			<span>{content}</span>
			{children}
		</div>
	),
	Dialog: ({ children, open }: any) => (open ? <div data-testid="hook-dialog">{children}</div> : null),
	DialogContent: ({ children }: any) => <div>{children}</div>,
	DialogDescription: ({ children }: any) => <p>{children}</p>,
	DialogFooter: ({ children }: any) => <div>{children}</div>,
	DialogHeader: ({ children }: any) => <div>{children}</div>,
	DialogTitle: ({ children }: any) => <h2>{children}</h2>,
	Select: ({ children, value, onValueChange }: any) => (
		<select value={value} onChange={(event) => onValueChange(event.target.value)}>
			{children}
		</select>
	),
	SelectContent: ({ children }: any) => <>{children}</>,
	SelectItem: ({ children, value }: any) => <option value={value}>{children}</option>,
	SelectTrigger: ({ children }: any) => <>{children}</>,
	SelectValue: () => null,
	AlertDialog: ({ children, open }: any) => (open ? <div>{children}</div> : null),
	AlertDialogAction: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
	AlertDialogCancel: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
	AlertDialogContent: ({ children }: any) => <div>{children}</div>,
	AlertDialogDescription: ({ children }: any) => <p>{children}</p>,
	AlertDialogFooter: ({ children }: any) => <div>{children}</div>,
	AlertDialogHeader: ({ children }: any) => <div>{children}</div>,
	AlertDialogTitle: ({ children }: any) => <h2>{children}</h2>,
}))

describe("HooksSettings", () => {
	const sessionHook: HookDefinition = {
		id: "session-hook",
		name: "Session context",
		enabled: true,
		phase: "sessionStart",
		executable: "node",
		argv: ["context.js"],
	}

	const preToolHook: HookDefinition = {
		id: "pre-tool-hook",
		name: "Guard edits",
		enabled: true,
		phase: "preToolUse",
		toolMatcher: ["apply_diff"],
		executable: "guard",
		argv: [],
	}

	const getTooltipButton = (label: string): HTMLButtonElement => {
		const button = screen.getByText(label).parentElement?.querySelector("button")
		if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing tooltip button: ${label}`)
		return button
	}

	beforeEach(() => {
		vi.stubGlobal("crypto", { randomUUID: () => "new-hook-id" })
	})

	afterEach(() => vi.unstubAllGlobals())

	it("creates a disabled hook and preserves exact argv boundaries", () => {
		const onChange = vi.fn()
		render(<HooksSettings hookDefinitions={[]} onChange={onChange} setErrorMessage={vi.fn()} />)

		fireEvent.click(screen.getByTestId("add-hook"))
		expect(screen.getByTestId("hook-enabled")).not.toBeChecked()
		fireEvent.change(screen.getByTestId("hook-name"), { target: { value: "Load context" } })
		fireEvent.change(screen.getByTestId("hook-executable"), { target: { value: "node" } })
		fireEvent.click(screen.getByText("settings:hooks.fields.addArgument"))
		fireEvent.change(screen.getByLabelText("settings:hooks.fields.argument"), {
			target: { value: " argument with spaces " },
		})
		fireEvent.click(screen.getByTestId("save-hook"))

		expect(onChange).toHaveBeenCalledWith([
			{
				id: "new-hook-id",
				name: "Load context",
				enabled: false,
				phase: "sessionStart",
				executable: "node",
				argv: [" argument with spaces "],
			},
		])
	})

	it("requires exact tool selection for before-tool hooks", () => {
		const setErrorMessage = vi.fn()
		render(<HooksSettings hookDefinitions={[]} onChange={vi.fn()} setErrorMessage={setErrorMessage} />)
		fireEvent.click(screen.getByTestId("add-hook"))
		fireEvent.change(screen.getByTestId("hook-name"), { target: { value: "Guard edits" } })
		fireEvent.change(screen.getByTestId("hook-executable"), { target: { value: "guard" } })
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "preToolUse" } })

		expect(screen.getByTestId("save-hook")).toBeDisabled()
		fireEvent.click(screen.getByLabelText("apply_diff"))
		expect(screen.getByTestId("save-hook")).toBeEnabled()
		expect(setErrorMessage).toHaveBeenCalledWith("settings:hooks.validation.invalid")
	})

	it("accepts exact custom and native MCP tool names", () => {
		const onChange = vi.fn()
		render(<HooksSettings hookDefinitions={[]} onChange={onChange} setErrorMessage={vi.fn()} />)
		fireEvent.click(screen.getByTestId("add-hook"))
		fireEvent.change(screen.getByTestId("hook-name"), { target: { value: "Dynamic guard" } })
		fireEvent.change(screen.getByTestId("hook-executable"), { target: { value: "guard" } })
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "preToolUse" } })
		fireEvent.change(screen.getByTestId("hook-dynamic-tools"), {
			target: { value: "my_custom_tool, mcp_local_search" },
		})
		fireEvent.click(screen.getByTestId("save-hook"))

		expect(onChange).toHaveBeenCalledWith([
			expect.objectContaining({ toolMatcher: ["my_custom_tool", "mcp_local_search"] }),
		])
	})

	it("edits a hook and updates exact tool and argument selections", () => {
		const onChange = vi.fn()
		render(<HooksSettings hookDefinitions={[preToolHook]} onChange={onChange} setErrorMessage={vi.fn()} />)

		fireEvent.click(getTooltipButton("settings:hooks.edit"))
		fireEvent.change(screen.getByTestId("hook-name"), { target: { value: "Guard reads" } })
		fireEvent.click(screen.getByLabelText("apply_diff"))
		expect(screen.getByTestId("save-hook")).toBeDisabled()
		fireEvent.click(screen.getByLabelText("read_file"))
		fireEvent.click(screen.getByText("settings:hooks.fields.addArgument"))
		fireEvent.change(screen.getByLabelText("settings:hooks.fields.argument"), {
			target: { value: "--strict" },
		})
		fireEvent.click(screen.getByTestId("save-hook"))

		expect(onChange).toHaveBeenCalledWith([
			{
				...preToolHook,
				name: "Guard reads",
				toolMatcher: ["read_file"],
				argv: ["--strict"],
			},
		])
	})

	it("removes an existing argument while editing", () => {
		const onChange = vi.fn()
		render(<HooksSettings hookDefinitions={[sessionHook]} onChange={onChange} setErrorMessage={vi.fn()} />)

		fireEvent.click(getTooltipButton("settings:hooks.edit"))
		const argument = screen.getByLabelText("settings:hooks.fields.argument")
		const removeButton = argument.parentElement?.querySelector("button")
		if (!(removeButton instanceof HTMLButtonElement)) throw new Error("Missing remove-argument button")
		fireEvent.click(removeButton)
		fireEvent.click(screen.getByTestId("save-hook"))

		expect(onChange).toHaveBeenCalledWith([{ ...sessionHook, argv: [] }])
	})

	it("deletes an existing hook after confirmation", () => {
		const onChange = vi.fn()
		render(<HooksSettings hookDefinitions={[sessionHook]} onChange={onChange} setErrorMessage={vi.fn()} />)

		fireEvent.click(getTooltipButton("settings:hooks.delete"))
		fireEvent.click(screen.getByRole("button", { name: "settings:hooks.delete" }))

		expect(onChange).toHaveBeenCalledWith([])
	})

	it("rejects normalized command fields and clears its error when cancelled", () => {
		const setErrorMessage = vi.fn()
		render(<HooksSettings hookDefinitions={[]} onChange={vi.fn()} setErrorMessage={setErrorMessage} />)

		fireEvent.click(screen.getByTestId("add-hook"))
		fireEvent.change(screen.getByTestId("hook-name"), { target: { value: " Invalid name " } })
		fireEvent.change(screen.getByTestId("hook-executable"), { target: { value: "node" } })

		expect(screen.getByRole("alert")).toHaveTextContent("settings:hooks.validation.invalid")
		expect(screen.getByTestId("save-hook")).toBeDisabled()
		fireEvent.click(screen.getByRole("button", { name: "settings:common.cancel" }))

		expect(screen.queryByTestId("hook-dialog")).not.toBeInTheDocument()
		expect(setErrorMessage).toHaveBeenLastCalledWith(undefined)
	})

	it("clears an owned validation error when unmounted", () => {
		const setErrorMessage = vi.fn()
		const { unmount } = render(
			<HooksSettings hookDefinitions={[]} onChange={vi.fn()} setErrorMessage={setErrorMessage} />,
		)

		fireEvent.click(screen.getByTestId("add-hook"))
		expect(setErrorMessage).toHaveBeenCalledWith("settings:hooks.validation.invalid")
		unmount()

		expect(setErrorMessage).toHaveBeenLastCalledWith(undefined)
	})
})
