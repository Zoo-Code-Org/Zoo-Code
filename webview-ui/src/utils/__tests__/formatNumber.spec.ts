import { formatCompact, formatCost } from "../formatNumber"

describe("formatCompact", () => {
	it("returns '0' for zero", () => {
		expect(formatCompact(0)).toBe("0")
	})

	it("returns '0' for negative zero", () => {
		expect(formatCompact(-0)).toBe("0")
	})

	it("formats numbers below 1,000 with toLocaleString", () => {
		expect(formatCompact(999)).toBe("999")
	})

	it("formats exactly 1,000 with K suffix", () => {
		expect(formatCompact(1_000)).toBe("1.0K")
	})

	it("formats 1,500 with K suffix and one decimal", () => {
		expect(formatCompact(1_500)).toBe("1.5K")
	})

	it("formats exactly 1,000,000 with M suffix", () => {
		expect(formatCompact(1_000_000)).toBe("1.00M")
	})

	it("formats 1,500,000 with M suffix and two decimals", () => {
		expect(formatCompact(1_500_000)).toBe("1.50M")
	})

	it("formats exactly 1,000,000,000 with B suffix", () => {
		expect(formatCompact(1_000_000_000)).toBe("1.00B")
	})

	it("formats 1,500,000,000 with B suffix and two decimals", () => {
		expect(formatCompact(1_500_000_000)).toBe("1.50B")
	})

	it("formats negative numbers with K suffix", () => {
		expect(formatCompact(-1_500)).toBe("-1.5K")
	})

	it("formats negative numbers with M suffix", () => {
		expect(formatCompact(-1_500_000)).toBe("-1.50M")
	})

	it("formats negative numbers with B suffix", () => {
		expect(formatCompact(-1_500_000_000)).toBe("-1.50B")
	})

	it("formats negative numbers below 1,000 with toLocaleString", () => {
		expect(formatCompact(-42)).toBe("-42")
	})

	it("formats very large numbers with B suffix", () => {
		expect(formatCompact(999_999_999_999)).toBe("1000.00B")
	})

	it("formats boundary just below 1,000", () => {
		expect(formatCompact(999)).toBe("999")
	})

	it("formats boundary at exactly 1,000", () => {
		expect(formatCompact(1_000)).toBe("1.0K")
	})

	it("formats boundary just below 1,000,000", () => {
		expect(formatCompact(999_999)).toBe("1000.0K")
	})

	it("formats boundary at exactly 1,000,000", () => {
		expect(formatCompact(1_000_000)).toBe("1.00M")
	})

	it("formats boundary just below 1,000,000,000", () => {
		expect(formatCompact(999_999_999)).toBe("1000.00M")
	})

	it("formats boundary at exactly 1,000,000,000", () => {
		expect(formatCompact(1_000_000_000)).toBe("1.00B")
	})

	it("handles NaN by returning 'NaN' via toLocaleString", () => {
		// NaN is not 0, abs(NaN) is NaN, which is < 1000, so toLocaleString is called
		expect(formatCompact(NaN)).toBe("NaN")
	})

	it("handles Infinity with B suffix", () => {
		expect(formatCompact(Infinity)).toBe("InfinityB")
	})

	it("handles -Infinity with B suffix", () => {
		expect(formatCompact(-Infinity)).toBe("-InfinityB")
	})
})

describe("formatCost", () => {
	it("returns '$0.00' for zero", () => {
		expect(formatCost(0)).toBe("$0.00")
	})

	it("returns '$0.00' for negative zero", () => {
		expect(formatCost(-0)).toBe("$0.00")
	})

	it("formats sub-cent values with 4 decimals", () => {
		expect(formatCost(0.005)).toBe("$0.0050")
	})

	it("formats values just below 0.01 with 4 decimals", () => {
		expect(formatCost(0.0099)).toBe("$0.0099")
	})

	it("formats exactly 0.01 with 2 decimals", () => {
		expect(formatCost(0.01)).toBe("$0.01")
	})

	it("formats typical cost with 2 decimals", () => {
		expect(formatCost(1.234)).toBe("$1.23")
	})

	it("formats large cost with 2 decimals", () => {
		expect(formatCost(1234.567)).toBe("$1234.57")
	})

	it("formats negative sub-cent values with 4 decimals", () => {
		expect(formatCost(-0.005)).toBe("$-0.0050")
	})

	it("formats negative values with 4 decimals (negative is always < 0.01)", () => {
		expect(formatCost(-1.5)).toBe("$-1.5000")
	})

	it("formats very small positive value", () => {
		expect(formatCost(0.0001)).toBe("$0.0001")
	})

	it("formats very large cost", () => {
		expect(formatCost(999999.99)).toBe("$999999.99")
	})

	it("handles NaN (falls through to toFixed(2))", () => {
		expect(formatCost(NaN)).toBe("$NaN")
	})

	it("handles Infinity (falls through to toFixed(2))", () => {
		expect(formatCost(Infinity)).toBe("$Infinity")
	})
})
