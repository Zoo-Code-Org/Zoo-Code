import { render, screen } from "@/utils/test-utils"

import { MessageTimestamp } from "../MessageTimestamp"

// Renders the tooltip's content as an attribute, so what it says can be asserted without hovering.
vi.mock("../../ui/standard-tooltip", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../ui/standard-tooltip")>()),
	StandardTooltip: ({ children, content }: { children: React.ReactNode; content: string }) => (
		<div data-testid="tooltip" data-content={content}>
			{children}
		</div>
	),
}))

const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m, d, h, min).getTime()

describe("MessageTimestamp", () => {
	it("renders a semantic <time> with the exact ISO value and a clock icon", () => {
		const ts = at(2020, 5, 15, 14, 41)
		render(<MessageTimestamp ts={ts} />)
		const el = screen.getByTestId("message-timestamp")
		expect(el.tagName).toBe("TIME")
		expect(el.getAttribute("datetime")).toBe(new Date(ts).toISOString())
		// Decorative icon is hidden from assistive tech: the text carries the meaning.
		expect(el.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true")
	})

	it("says Today for a message sent now", () => {
		render(<MessageTimestamp ts={Date.now()} />)
		expect(screen.getByTestId("message-timestamp").textContent).toContain("Today")
	})

	it("says Yesterday for yesterday's messages", () => {
		const d = new Date()
		d.setDate(d.getDate() - 1)
		d.setHours(11, 43, 0, 0)
		render(<MessageTimestamp ts={d.getTime()} />)
		expect(screen.getByTestId("message-timestamp").textContent).toContain("Yesterday")
	})

	it("honours the 24-hour setting", () => {
		const d = new Date()
		d.setHours(14, 41, 0, 0)
		render(<MessageTimestamp ts={d.getTime()} timeFormat="24h" />)
		expect(screen.getByTestId("message-timestamp").textContent).toContain("14:41")
	})

	it("honours the 12-hour setting", () => {
		const d = new Date()
		d.setHours(14, 41, 0, 0)
		render(<MessageTimestamp ts={d.getTime()} timeFormat="12h" />)
		expect(screen.getByTestId("message-timestamp").textContent).toMatch(/2:41\s?PM/i)
	})

	it("honours the date order for older messages", () => {
		render(<MessageTimestamp ts={at(2019, 0, 2, 9, 5)} timeFormat="24h" dateFormat="ymd" />)
		expect(screen.getByTestId("message-timestamp").textContent).toContain("2019-01-02, 09:05")
	})

	it.each([
		["24h", "ymd", /^2019-01-02, 09:05$/],
		["24h", "dmy", /^02\/01\/2019, 09:05$/],
		["12h", "mdy", /^01\/02\/2019, 9:05\s?AM$/],
	] as const)("gives the full date and time in the tooltip (%s, %s)", (timeFormat, dateFormat, expected) => {
		render(<MessageTimestamp ts={at(2019, 0, 2, 9, 5)} timeFormat={timeFormat} dateFormat={dateFormat} />)

		expect(screen.getByTestId("tooltip").getAttribute("data-content")).toMatch(expected)
	})

	it("gives the full date in the tooltip even when the label says Today", () => {
		const d = new Date()
		d.setHours(14, 41, 0, 0)
		render(<MessageTimestamp ts={d.getTime()} timeFormat="24h" dateFormat="ymd" />)

		const tooltip = screen.getByTestId("tooltip").getAttribute("data-content")!
		expect(tooltip).toMatch(/^\d{4}-\d{2}-\d{2}, 14:41$/)
		expect(screen.getByTestId("message-timestamp").textContent).toContain("Today")
	})

	it("needs no provider or context: it is purely presentational", () => {
		expect(() => render(<MessageTimestamp ts={Date.now()} />)).not.toThrow()
	})

	it.each([0, -1, NaN, Infinity, 8.64e15 + 1, -8.64e15 - 1, Number.MAX_VALUE])(
		"renders nothing for an invalid or out-of-range timestamp (%s)",
		(ts) => {
			render(<MessageTimestamp ts={ts} />)
			expect(screen.queryByTestId("message-timestamp")).toBeNull()
		},
	)

	it("still renders at the largest representable date", () => {
		expect(() => render(<MessageTimestamp ts={8.64e15} />)).not.toThrow()
		expect(screen.getByTestId("message-timestamp")).toBeTruthy()
	})

	it.each([0, -1, NaN, Infinity])("renders nothing for an invalid timestamp (%s)", (ts) => {
		render(<MessageTimestamp ts={ts} />)
		expect(screen.queryByTestId("message-timestamp")).toBeNull()
	})

	it("passes a custom className through", () => {
		render(<MessageTimestamp ts={Date.now()} className="custom-class" />)
		expect(screen.getByTestId("message-timestamp").className).toContain("custom-class")
	})
})
