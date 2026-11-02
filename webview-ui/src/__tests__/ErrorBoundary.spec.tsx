import React from "react"
import { render, screen } from "@testing-library/react"
import ErrorBoundary from "../components/ErrorBoundary"
import { recordDiagnosticsError } from "@src/utils/diagnostics"
import { EXTERNAL_LINKS } from "../constants/externalLinks"

// Mock telemetry client
vi.mock("@src/utils/TelemetryClient", () => ({
	telemetryClient: {
		capture: vi.fn(),
	},
}))

vi.mock("react-i18next", () => ({
	withTranslation:
		() => (Component: React.ComponentType<{ children: React.ReactNode; t: (key: string) => string }>) => {
			const MockedComponent = (props: { children: React.ReactNode }) => <Component {...props} t={(key) => key} />
			return MockedComponent
		},
}))

vi.mock("@src/utils/diagnostics", () => ({ recordDiagnosticsError: vi.fn() }))
vi.mock("@src/utils/sourceMapUtils", () => ({
	enhanceErrorWithSourceMaps: vi.fn(async (error: Error) => error),
}))

// Test component that can throw errors on demand
const ErrorThrower = ({ shouldThrow = false, message = "Test error" }: { shouldThrow?: boolean; message?: string }) => {
	if (shouldThrow) {
		throw new Error(message)
	}
	return <div>No error</div>
}

describe("ErrorBoundary", () => {
	// Suppress console errors during tests
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		vi.mocked(recordDiagnosticsError).mockClear()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("renders children when there is no error", () => {
		render(
			<ErrorBoundary>
				<div data-testid="test-child">Test Content</div>
			</ErrorBoundary>,
		)

		expect(screen.getByTestId("test-child")).toBeInTheDocument()
		expect(screen.getByText("Test Content")).toBeInTheDocument()
	})

	it("records a caught error once under StrictMode", () => {
		render(
			<React.StrictMode>
				<ErrorBoundary>
					<ErrorThrower shouldThrow message="StrictMode error" />
				</ErrorBoundary>
			</React.StrictMode>,
		)

		expect(recordDiagnosticsError).toHaveBeenCalledTimes(1)
		expect(recordDiagnosticsError).toHaveBeenCalledWith("errorBoundary", expect.any(Error))
	})

	it("renders error UI when a child component throws", () => {
		vi.stubEnv("PKG_VERSION", "1.2.3")

		// Using the React testing library's render method with an error boundary is tricky
		// We need to catch and ignore the error during the test
		const spy = vi.spyOn(console, "error").mockImplementation(() => {})

		render(
			<ErrorBoundary>
				<ErrorThrower shouldThrow={true} message="Test component error" />
			</ErrorBoundary>,
		)

		// Verify error boundary elements are displayed - using partial matchers to account for version info
		expect(screen.getByText(/errorBoundary.title/)).toBeInTheDocument()

		// Check for the GitHub link
		const githubLink = screen.getByRole("link", { name: /errorBoundary.githubText/ })
		expect(githubLink).toBeInTheDocument()
		expect(githubLink).toHaveAttribute("href", EXTERNAL_LINKS.GITHUB_ISSUES)

		// Check for other error boundary elements
		expect(screen.getByText(/errorBoundary.copyInstructions/)).toBeInTheDocument()
		expect(screen.getByText(/errorBoundary.errorStack/)).toBeInTheDocument()

		// In test environments, the componentStack might not always be available
		// so we don't check for it to make the test more reliable

		// The test error message should be included in the error display
		expect(screen.getByText(/Test component error/)).toBeInTheDocument()

		spy.mockRestore()
	})
})
