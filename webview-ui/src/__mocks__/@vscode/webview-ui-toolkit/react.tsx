import React from "react"

export const VSCodeCheckbox = ({ children, onChange, checked, "data-testid": dataTestId, ...props }: any) => (
	<label data-testid={dataTestId}>
		<input type="checkbox" checked={checked} onChange={(e: any) => onChange?.(e)} {...props} />
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
