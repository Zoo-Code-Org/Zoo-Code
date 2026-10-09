import { createReadFileTool } from "../read_file"
import readFiles from "../read_files"
import { READ_FILES_TOOL_NAME } from "@roo-code/types"

vi.mock("../read_file", () => ({
	createReadFileTool: vi.fn(() => {
		throw new Error("Batch schema must not instantiate the single-file tool")
	}),
}))

it("constructs the batch tool without loading or creating the single-file definition", () => {
	expect(readFiles.function.name).toBe(READ_FILES_TOOL_NAME)
	expect(createReadFileTool).not.toHaveBeenCalled()
})
