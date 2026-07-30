import type { RooCodeResourceDiagnosticEventName, RooCodeResourceDiagnostics } from "@roo-code/types"

export type ResourceDiagnosticsConvergenceOptions = {
	baseline: RooCodeResourceDiagnostics
	final: RooCodeResourceDiagnostics
	observedChildTaskIds?: string[]
}

type DiagnosticIssue = {
	name: string
	baseline: number
	final: number
}

const formatIssue = ({ name, baseline, final }: DiagnosticIssue) => `${name}: baseline=${baseline}, final=${final}`

const listenerCountIssues = (
	baseline: RooCodeResourceDiagnostics,
	final: RooCodeResourceDiagnostics,
): DiagnosticIssue[] => {
	const listenerNames = new Set<RooCodeResourceDiagnosticEventName>([
		...(Object.keys(baseline.listenerCounts) as RooCodeResourceDiagnosticEventName[]),
		...(Object.keys(final.listenerCounts) as RooCodeResourceDiagnosticEventName[]),
	])

	return [...listenerNames].sort().flatMap((listenerName) => {
		const baselineCount = baseline.listenerCounts[listenerName] ?? 0
		const finalCount = final.listenerCounts[listenerName] ?? 0

		return finalCount === baselineCount
			? []
			: [
					{
						name: `listenerCounts.${listenerName}`,
						baseline: baselineCount,
						final: finalCount,
					},
				]
	})
}

export const getResourceDiagnosticsConvergenceIssues = ({
	baseline,
	final,
}: ResourceDiagnosticsConvergenceOptions): DiagnosticIssue[] => {
	const issues: DiagnosticIssue[] = []

	if (final.registeredTaskCount !== baseline.registeredTaskCount) {
		issues.push({
			name: "registeredTaskCount",
			baseline: baseline.registeredTaskCount,
			final: final.registeredTaskCount,
		})
	}

	// A final zero intentionally treats a shrinking task stack as converged, unlike registeredTaskCount.
	if (final.currentTaskStackLength !== baseline.currentTaskStackLength && final.currentTaskStackLength !== 0) {
		issues.push({
			name: "currentTaskStackLength",
			baseline: baseline.currentTaskStackLength,
			final: final.currentTaskStackLength,
		})
	}

	issues.push(...listenerCountIssues(baseline, final))

	return issues
}

export const assertResourceDiagnosticsConverged = (options: ResourceDiagnosticsConvergenceOptions) => {
	const issues = getResourceDiagnosticsConvergenceIssues(options)

	if (issues.length === 0) {
		return
	}

	const staleChildHint =
		options.observedChildTaskIds && options.observedChildTaskIds.length > 0
			? ` Observed child task ids: ${options.observedChildTaskIds.join(", ")}.`
			: ""

	throw new Error(
		`Resource diagnostics did not converge after orchestrator cleanup: ${issues.map(formatIssue).join("; ")}.${staleChildHint}`,
	)
}
