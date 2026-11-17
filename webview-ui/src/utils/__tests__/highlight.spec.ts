import { highlightFzfMatch } from "../highlight"

describe("highlightFzfMatch", () => {
	it.each([
		{ name: "no match positions", positions: [], expected: "&lt;b&gt;x&lt;/b&gt;" },
		{
			name: "match positions",
			positions: [3],
			expected: '&lt;b&gt;<span class="history-item-highlight">x</span>&lt;/b&gt;',
		},
	])("escapes HTML in the text with $name", ({ positions, expected }) => {
		expect(highlightFzfMatch("<b>x</b>", positions)).toBe(expected)
	})

	it("wraps matched characters in the highlight class", () => {
		expect(highlightFzfMatch("abc", [0, 2], "hl")).toBe('<span class="hl">a</span>b<span class="hl">c</span>')
	})
})
