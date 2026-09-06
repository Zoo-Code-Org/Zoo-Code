import { render, screen } from "@/utils/test-utils"

import McpResourceRow from "../McpResourceRow"

const resource = {
	uri: "file:///workspace/readme.md",
	name: "Workspace readme",
	description: "Project overview",
	mimeType: "text/markdown",
}

describe("McpResourceRow", () => {
	it("shows resource descriptions by default", () => {
		render(<McpResourceRow item={resource} />)

		expect(screen.getByText("Workspace readme: Project overview")).toBeInTheDocument()
	})

	it("hides only the description when requested", () => {
		render(<McpResourceRow item={resource} showDescription={false} />)

		expect(screen.getByText("Workspace readme")).toBeInTheDocument()
		expect(screen.queryByText(/Project overview/)).not.toBeInTheDocument()
		expect(screen.getByText("file:///workspace/readme.md")).toBeInTheDocument()
		expect(screen.getByText("text/markdown")).toBeInTheDocument()
	})

	it("does not replace a hidden description with placeholder text", () => {
		render(
			<McpResourceRow
				item={{ uriTemplate: "file:///{path}", name: "", description: "Reads a file" }}
				showDescription={false}
			/>,
		)

		expect(screen.queryByText("Reads a file")).not.toBeInTheDocument()
		expect(screen.queryByText("No description")).not.toBeInTheDocument()
		expect(screen.getByText("file:///{path}")).toBeInTheDocument()
	})
})
