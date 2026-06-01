import React from "react"

export const VSCodeCheckbox = ({ children, onChange, checked, "data-testid": dataTestId, ...props }: any) => (
	<label>
		<input
			type="checkbox"
			data-testid={dataTestId}
			checked={checked}
			onChange={(e: any) => onChange?.(e)}
			{...props}
		/>
		{children}
	</label>
)

export const VSCodeRadioGroup = ({ children, ...props }: any) => <div {...props}>{children}</div>

export const VSCodeRadio = ({ children, value, ...props }: any) => (
	<label>
		<input type="radio" value={value} {...props} />
		{children}
	</label>
)

export const VSCodeTextArea = ({ value, onChange, "data-testid": dataTestId, ...props }: any) => (
	<textarea
		data-testid={dataTestId}
		value={value ?? ""}
		onChange={(e: any) => onChange?.(e)}
		// Bridge: the real toolkit dispatches a CustomEvent("change") with the
		// new value carried on `event.detail.target.value`. Existing tests rely
		// on this. Forward such events to the React onChange handler so the
		// component sees the synthesized detail.
		ref={(el: HTMLTextAreaElement | null) => {
			if (!el) return
			if ((el as any).__vscodeChangeBridge) return
			;(el as any).__vscodeChangeBridge = true
			el.addEventListener("change", (e: Event) => {
				const ce = e as CustomEvent
				if (ce.detail && (ce.detail as any).target) {
					onChange?.(ce as unknown as React.ChangeEvent<HTMLTextAreaElement>)
				}
			})
		}}
		{...props}
	/>
)

export const VSCodeLink = ({ children, href, ...props }: any) => (
	<a href={href} {...props}>
		{children}
	</a>
)

export const VSCodeTextField = ({ value, onInput, "data-testid": dataTestId, children, ...props }: any) => (
	<div>
		<input data-testid={dataTestId} value={value} onInput={onInput} {...props} />
		{children}
	</div>
)

export const VSCodeButton = ({ children, onClick, "data-testid": dataTestId, ...props }: any) => (
	<button data-testid={dataTestId} onClick={onClick} {...props}>
		{children}
	</button>
)

export const VSCodeBadge = ({ children, ...props }: any) => <span {...props}>{children}</span>

export const VSCodeProgressRing = (props: any) => <div role="progressbar" {...props} />

export const VSCodeDropdown = ({ children, value, onChange, "data-testid": dataTestId, ...props }: any) => (
	<select data-testid={dataTestId} value={value} onChange={(e: any) => onChange?.(e)} {...props}>
		{children}
	</select>
)

export const VSCodeOption = ({ children, value, ...props }: any) => (
	<option value={value} {...props}>
		{children}
	</option>
)

export const VSCodePanels = ({ children, ...props }: any) => <div {...props}>{children}</div>

export const VSCodePanelTab = ({ children, ...props }: any) => <div {...props}>{children}</div>

export const VSCodePanelView = ({ children, ...props }: any) => <div {...props}>{children}</div>
