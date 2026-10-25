import { render, screen, fireEvent } from "@/utils/test-utils"

import { BatchFilePermission } from "../BatchFilePermission"

const mockVscodePostMessage = vi.fn()

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (...args: any[]) => mockVscodePostMessage(...args),
	},
}))

describe("BatchFilePermission", () => {
	const mockOnPermissionResponse = vi.fn()

	const mockFiles = [
		{
			key: "file1",
			path: "src/components/Button.tsx",
			content: "src/components/Button.tsx",
			lineSnippet: "export const Button = () => {",
			isOutsideWorkspace: false,
		},
		{
			key: "file2",
			path: "../outside/config.json",
			content: "/absolute/path/to/outside/config.json",
			lineSnippet: '{ "apiKey": "..." }',
			isOutsideWorkspace: true,
		},
		{
			key: "file3",
			path: "tests/Button.test.tsx",
			content: "tests/Button.test.tsx",
			lineSnippet: "describe('Button', () => {",
			isOutsideWorkspace: false,
		},
	]

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders file list correctly", () => {
		render(
			<BatchFilePermission files={mockFiles} onPermissionResponse={mockOnPermissionResponse} ts={Date.now()} />,
		)

		// Check that all files are rendered
		expect(screen.getByText(/Button\.tsx/)).toBeInTheDocument()
		expect(screen.getByText(/config\.json/)).toBeInTheDocument()
		expect(screen.getByText(/Button\.test\.tsx/)).toBeInTheDocument()

		// Check that line snippets are shown
		expect(screen.getByText(/export const Button = \(\) => \{/)).toBeInTheDocument()
		expect(screen.getByText(/\{ "apiKey": "\.\.\." \}/)).toBeInTheDocument()
		expect(screen.getByText(/describe\('Button', \(\) => \{/)).toBeInTheDocument()
	})

	it("renders nothing when files array is empty", () => {
		const { container } = render(
			<BatchFilePermission files={[]} onPermissionResponse={mockOnPermissionResponse} ts={Date.now()} />,
		)

		expect(container.firstChild).toBeNull()
	})

	it("renders nothing when onPermissionResponse is not provided", () => {
		const { container } = render(
			<BatchFilePermission files={mockFiles} onPermissionResponse={undefined} ts={Date.now()} />,
		)

		expect(container.firstChild).toBeNull()
	})

	it("opens file when clicking on file item", () => {
		render(
			<BatchFilePermission files={mockFiles} onPermissionResponse={mockOnPermissionResponse} ts={Date.now()} />,
		)

		// The onClick is on the ToolUseBlockHeader which contains the file path text
		// Find the header that contains our file path and click it
		const filePathElement = screen.getByText(/Button\.tsx.*export const Button/)
		// The ToolUseBlockHeader is the parent div with the flex class
		const headerElement = filePathElement.closest(".flex.items-center.select-none")

		if (headerElement) {
			fireEvent.click(headerElement)
		}

		expect(mockVscodePostMessage).toHaveBeenCalledWith({
			type: "openFile",
			text: "src/components/Button.tsx",
		})
	})

	it("handles files with paths starting with dot correctly", () => {
		const filesWithDotPath = [
			{
				key: "file1",
				path: "./src/index.ts",
				content: "./src/index.ts",
				lineSnippet: "import React from 'react'",
			},
		]

		render(
			<BatchFilePermission
				files={filesWithDotPath}
				onPermissionResponse={mockOnPermissionResponse}
				ts={Date.now()}
			/>,
		)

		// Should render dot before the path
		expect(screen.getByText(".")).toBeInTheDocument()
		expect(screen.getByText(/\/src\/index\.ts/)).toBeInTheDocument()
	})

	it("re-renders when timestamp changes", () => {
		const { rerender } = render(
			<BatchFilePermission files={mockFiles} onPermissionResponse={mockOnPermissionResponse} ts={1000} />,
		)

		// Initial render
		expect(screen.getByText(/Button\.tsx/)).toBeInTheDocument()

		// Re-render with new timestamp
		rerender(<BatchFilePermission files={mockFiles} onPermissionResponse={mockOnPermissionResponse} ts={2000} />)

		// Should still show files
		expect(screen.getByText(/Button\.tsx/)).toBeInTheDocument()
	})

	it("displays external link icon for all files", () => {
		render(
			<BatchFilePermission files={mockFiles} onPermissionResponse={mockOnPermissionResponse} ts={Date.now()} />,
		)

		// All files should have external link icons
		const externalLinkIcons = screen.getAllByText((_content, element) => {
			return element?.classList?.contains("codicon-link-external") ?? false
		})
		expect(externalLinkIcons).toHaveLength(mockFiles.length)
	})
})
