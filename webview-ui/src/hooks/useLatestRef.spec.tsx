import { useLayoutEffect, useRef, type MutableRefObject } from "react"
import { render } from "@testing-library/react"

import { useLatestRef } from "./useLatestRef"

// A later sibling's layout effect runs in the same commit, after this component's layout effects and before any passive
// effect: it is where a message that arrives between the commit and the passive effects would be handled.
const Holder = ({ value, holder }: { value: number; holder: { ref?: MutableRefObject<number> } }) => {
	holder.ref = useLatestRef(value)
	return null
}

const Reader = ({ holder, seen }: { holder: { ref?: MutableRefObject<number> }; seen: number[] }) => {
	const first = useRef(true)
	useLayoutEffect(() => {
		if (first.current) first.current = false
		else seen.push(holder.ref!.current)
	})
	return null
}

describe("useLatestRef", () => {
	it("holds the value of the commit that is being finished, for whatever runs right after the commit phase", () => {
		const holder: { ref?: MutableRefObject<number> } = {}
		const seen: number[] = []
		const ui = (value: number) => (
			<>
				<Holder value={value} holder={holder} />
				<Reader holder={holder} seen={seen} />
			</>
		)
		const { rerender } = render(ui(1))

		rerender(ui(2))
		rerender(ui(3))

		expect(seen).toEqual([2, 3])
	})

	it("starts with the value it is given, and keeps one object for the life of the component", () => {
		const holder: { ref?: MutableRefObject<number> } = {}
		const { rerender } = render(<Holder value={5} holder={holder} />)
		const first = holder.ref

		expect(first?.current).toBe(5)
		rerender(<Holder value={6} holder={holder} />)

		expect(holder.ref).toBe(first)
		expect(holder.ref?.current).toBe(6)
	})
})
