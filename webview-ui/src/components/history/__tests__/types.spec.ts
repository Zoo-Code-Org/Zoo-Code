import { getTaskDisplayTitle } from "../types"

describe("getTaskDisplayTitle", () => {
	it.each([
		["the custom title first", { task: "Prompt", title: "Custom", autoTitle: "Generated" }, "Custom"],
		["the generated title without a custom title", { task: "Prompt", autoTitle: "Generated" }, "Generated"],
		["the prompt when neither title is set", { task: "Prompt" }, "Prompt"],
		["the prompt when titles are empty", { task: "Prompt", title: "", autoTitle: "" }, "Prompt"],
	])("returns %s", (_label, item, expected) => {
		expect(getTaskDisplayTitle(item)).toBe(expected)
	})
})
