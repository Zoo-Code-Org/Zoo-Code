import { Component, type ErrorInfo, type ReactNode } from "react"

interface Props {
	children: ReactNode
	/** Optional fallback rendered when an error has been caught. */
	fallback?: ReactNode
}

interface State {
	hasError: boolean
}

/**
 * Swallows errors thrown by the task-organization feature (pin, folder, DnD)
 * so that a failure in the new code never breaks the existing Virtuoso
 * rendering pipeline.
 *
 * On error the boundary logs a warning and renders children as-is (i.e. the
 * new feature is silently disabled rather than crashing the whole view).
 */
export class TaskOrganizationErrorBoundary extends Component<Props, State> {
	state: State = { hasError: false }

	static getDerivedStateFromError(): State {
		return { hasError: true }
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error(
			"[TaskOrganizationErrorBoundary] Task-organization feature error — pin/folder UI disabled for this render:\n",
			error,
			info.componentStack,
		)
	}

	render(): ReactNode {
		// When an error has been caught, render the provided fallback (or null)
		// so the crashing subtree is unmounted. Otherwise render children.
		if (this.state.hasError) {
			return this.props.fallback ?? null
		}
		return this.props.children
	}
}
