import { render, screen } from "@/utils/test-utils"

import React from "react"

import { TaskOrganizationErrorBoundary } from "../TaskOrganizationErrorBoundary"

// Suppress React error boundary console noise in test output
const originalConsoleError = console.error
beforeAll(() => {
	console.error = vi.fn()
})
afterAll(() => {
	console.error = originalConsoleError
})

/** A child component that always throws on render. */
const ThrowingChild = () => {
	throw new Error("Organization feature exploded")
}

/** A normal child that renders text. */
const SafeChild = () => <div data-testid="safe-child">I am safe</div>

describe("TaskOrganizationErrorBoundary", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders children normally when no error occurs", () => {
		render(
			<TaskOrganizationErrorBoundary fallback={<div data-testid="fallback">Fallback</div>}>
				<SafeChild />
			</TaskOrganizationErrorBoundary>,
		)

		expect(screen.getByTestId("safe-child")).toBeInTheDocument()
		expect(screen.queryByTestId("fallback")).not.toBeInTheDocument()
	})

	it("renders fallback when a child throws", () => {
		render(
			<TaskOrganizationErrorBoundary fallback={<div data-testid="fallback">Fallback rendered</div>}>
				<ThrowingChild />
			</TaskOrganizationErrorBoundary>,
		)

		expect(screen.getByTestId("fallback")).toBeInTheDocument()
		expect(screen.getByText("Fallback rendered")).toBeInTheDocument()
		expect(screen.queryByTestId("safe-child")).not.toBeInTheDocument()
	})

	it("renders null when a child throws and no fallback is provided", () => {
		const { container } = render(
			<TaskOrganizationErrorBoundary>
				<ThrowingChild />
			</TaskOrganizationErrorBoundary>,
		)

		// With no fallback, the boundary renders null
		expect(container.innerHTML).toBe("")
	})

	it("logs a warning when an error is caught", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		render(
			<TaskOrganizationErrorBoundary fallback={<div>Fallback</div>}>
				<ThrowingChild />
			</TaskOrganizationErrorBoundary>,
		)

		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("[TaskOrganizationErrorBoundary]"),
			expect.any(Error),
			expect.any(String),
		)

		errorSpy.mockRestore()
	})

	it("resets error state when remounted with a new key", () => {
		const { rerender } = render(
			<TaskOrganizationErrorBoundary key="v1" fallback={<div data-testid="fallback">Fallback</div>}>
				<ThrowingChild />
			</TaskOrganizationErrorBoundary>,
		)

		// First render: error caught, fallback shown
		expect(screen.getByTestId("fallback")).toBeInTheDocument()

		// Remount with a different key and a safe child
		rerender(
			<TaskOrganizationErrorBoundary key="v2" fallback={<div data-testid="fallback">Fallback</div>}>
				<SafeChild />
			</TaskOrganizationErrorBoundary>,
		)

		// After remount the boundary is fresh — safe child should render
		expect(screen.getByTestId("safe-child")).toBeInTheDocument()
		expect(screen.queryByTestId("fallback")).not.toBeInTheDocument()
	})

	it("renders fallback instead of throwing subtree (throwing child is not in the DOM)", () => {
		render(
			<TaskOrganizationErrorBoundary fallback={<div data-testid="counting-fallback">Fallback content</div>}>
				<ThrowingChild />
			</TaskOrganizationErrorBoundary>,
		)

		// The fallback should be rendered and the throwing child should not
		expect(screen.getByTestId("counting-fallback")).toBeInTheDocument()
		expect(screen.getByText("Fallback content")).toBeInTheDocument()
		// The throwing child should not be in the DOM
		expect(document.body.textContent).not.toContain("safe-child")
	})

	it("renders fallback with Virtuoso-style grouped list content", () => {
		// Simulate the real fallback: a list of task group names
		const groups = [
			{ id: "group-1", label: "Task Alpha" },
			{ id: "group-2", label: "Task Beta" },
		]

		render(
			<TaskOrganizationErrorBoundary
				fallback={
					<div data-testid="baseline-list">
						{groups.map((g) => (
							<div key={g.id} data-testid={`group-${g.id}`}>
								{g.label}
							</div>
						))}
					</div>
				}>
				<ThrowingChild />
			</TaskOrganizationErrorBoundary>,
		)

		expect(screen.getByTestId("baseline-list")).toBeInTheDocument()
		expect(screen.getByTestId("group-group-1")).toHaveTextContent("Task Alpha")
		expect(screen.getByTestId("group-group-2")).toHaveTextContent("Task Beta")
	})
})
