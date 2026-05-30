import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"

export const SelfImprovingStatus = () => {
	const { t } = useAppTranslation()
	const { selfImprovingStatus, experiments } = useExtensionState()

	const isExperimentEnabled = experiments?.selfImproving ?? false
	const status = selfImprovingStatus

	if (!isExperimentEnabled) {
		return null
	}

	if (!status) {
		return (
			<div className="mt-3 rounded border border-vscode-panel-border bg-vscode-editor-background p-3 text-sm">
				<p className="text-vscode-descriptionForeground">
					{t("settings:experimental.SELF_IMPROVING.statusLoading", { defaultValue: "Loading status..." })}
				</p>
			</div>
		)
	}

	return (
		<div className="mt-3 rounded border border-vscode-panel-border bg-vscode-editor-background p-3 text-sm">
			<h4 className="mb-2 font-medium">
				{t("settings:experimental.SELF_IMPROVING.statusTitle", { defaultValue: "Self-Improving Status" })}
			</h4>
			<table className="w-full text-xs">
				<tbody>
					<tr className="border-b border-vscode-panel-border">
						<td className="py-1 pr-3 text-vscode-descriptionForeground">
							{t("settings:experimental.SELF_IMPROVING.statusEnabled", { defaultValue: "Enabled" })}
						</td>
						<td className="py-1 text-right font-medium">{status.enabled ? "Yes" : "No"}</td>
					</tr>
					<tr className="border-b border-vscode-panel-border">
						<td className="py-1 pr-3 text-vscode-descriptionForeground">
							{t("settings:experimental.SELF_IMPROVING.statusStarted", { defaultValue: "Started" })}
						</td>
						<td className="py-1 text-right font-medium">{status.started ? "Yes" : "No"}</td>
					</tr>
					<tr className="border-b border-vscode-panel-border">
						<td className="py-1 pr-3 text-vscode-descriptionForeground">
							{t("settings:experimental.SELF_IMPROVING.statusPatterns", { defaultValue: "Patterns" })}
						</td>
						<td className="py-1 text-right font-medium">{status.patternCount}</td>
					</tr>
					<tr className="border-b border-vscode-panel-border">
						<td className="py-1 pr-3 text-vscode-descriptionForeground">
							{t("settings:experimental.SELF_IMPROVING.statusEvents", { defaultValue: "Events" })}
						</td>
						<td className="py-1 text-right font-medium">{status.eventCount}</td>
					</tr>
					<tr className="border-b border-vscode-panel-border">
						<td className="py-1 pr-3 text-vscode-descriptionForeground">
							{t("settings:experimental.SELF_IMPROVING.statusActions", { defaultValue: "Pending Actions" })}
						</td>
						<td className="py-1 text-right font-medium">{status.actionCount}</td>
					</tr>
					<tr className="border-b border-vscode-panel-border">
						<td className="py-1 pr-3 text-vscode-descriptionForeground">
							{t("settings:experimental.SELF_IMPROVING.statusMemory", { defaultValue: "Memory Entries" })}
						</td>
						<td className="py-1 text-right font-medium">{status.memoryEntries}</td>
					</tr>
					<tr className="border-b border-vscode-panel-border">
						<td className="py-1 pr-3 text-vscode-descriptionForeground">
							{t("settings:experimental.SELF_IMPROVING.statusSkills", { defaultValue: "Skill Records" })}
						</td>
						<td className="py-1 text-right font-medium">{status.skillRecords}</td>
					</tr>
					<tr className="border-b border-vscode-panel-border">
						<td className="py-1 pr-3 text-vscode-descriptionForeground">
							{t("settings:experimental.SELF_IMPROVING.statusBackend", { defaultValue: "Memory Backend" })}
						</td>
						<td className="py-1 text-right font-medium">{status.memoryBackend ?? "builtin"}</td>
					</tr>
					{status.lastReviewAt && (
						<tr className="border-b border-vscode-panel-border">
							<td className="py-1 pr-3 text-vscode-descriptionForeground">
								{t("settings:experimental.SELF_IMPROVING.statusLastReview", {
									defaultValue: "Last Review",
								})}
							</td>
							<td className="py-1 text-right font-medium">
								{new Date(status.lastReviewAt).toLocaleTimeString()}
							</td>
						</tr>
					)}
					{status.lastCuratorRunAt && (
						<tr className="border-b border-vscode-panel-border">
							<td className="py-1 pr-3 text-vscode-descriptionForeground">
								{t("settings:experimental.SELF_IMPROVING.statusLastCurator", {
									defaultValue: "Last Curator Run",
								})}
							</td>
							<td className="py-1 text-right font-medium">
								{new Date(status.lastCuratorRunAt).toLocaleTimeString()}
							</td>
						</tr>
					)}
					{/* Auto Mode sub-status */}
					{status.autoMode && (
						<tr className="border-b border-vscode-panel-border">
							<td className="py-1 pr-3 text-vscode-descriptionForeground">Auto Mode</td>
							<td className="py-1 text-right font-medium">
								{String(status.autoMode.status ?? status.autoMode.mode ?? "—")}
							</td>
						</tr>
					)}
					{/* Review Team sub-status */}
					{status.reviewTeam && (
						<tr className="border-b border-vscode-panel-border">
							<td className="py-1 pr-3 text-vscode-descriptionForeground">Review Team</td>
							<td className="py-1 text-right font-medium">
								{status.reviewTeam.lastReview
									? new Date(status.reviewTeam.lastReview as number).toLocaleTimeString()
									: status.reviewTeam.enabled
										? "Active"
										: "Inactive"}
							</td>
						</tr>
					)}
					{/* Question Evaluator sub-status */}
					{status.questionEvaluator && (
						<tr className="border-b border-vscode-panel-border">
							<td className="py-1 pr-3 text-vscode-descriptionForeground">Question Evaluator</td>
							<td className="py-1 text-right font-medium">
								{status.questionEvaluator.lastEvaluation
									? new Date(status.questionEvaluator.lastEvaluation as number).toLocaleTimeString()
									: status.questionEvaluator.enabled
										? "Active"
										: "Inactive"}
							</td>
						</tr>
					)}
					{/* Resilience sub-status */}
					{status.resilience && (
						<tr className="border-b border-vscode-panel-border">
							<td className="py-1 pr-3 text-vscode-descriptionForeground">Resilience</td>
							<td className="py-1 text-right font-medium">
								{status.resilience.isInRecoveryMode
									? `Recovery (${status.resilience.consecutiveFailures ?? 0} failures)`
									: `OK (${status.resilience.consecutiveFailures ?? 0} failures)`}
							</td>
						</tr>
					)}
					{/* Tool Error Healer sub-status */}
					{status.toolErrorHealer && (
						<tr className="border-b border-vscode-panel-border">
							<td className="py-1 pr-3 text-vscode-descriptionForeground">Tool Error Healer</td>
							<td className="py-1 text-right font-medium">
								{status.toolErrorHealer.learnedCorrections != null
									? `${status.toolErrorHealer.learnedCorrections} corrections`
									: "Active"}
							</td>
						</tr>
					)}
					{/* Prevention Engine sub-status */}
					{status.preventionEngine && (
						<tr>
							<td className="py-1 pr-3 text-vscode-descriptionForeground">Prevention Engine</td>
							<td className="py-1 text-right font-medium">
								{status.preventionEngine.cascadeCount != null
									? `${status.preventionEngine.cascadeCount} cascades`
									: status.preventionEngine.lastPrevention
										? `Last: ${new Date(status.preventionEngine.lastPrevention as number).toLocaleTimeString()}`
										: "Active"}
							</td>
						</tr>
					)}
					{/* Verification Engine sub-status */}
					{status.verificationEngine && (
						<tr className="border-b border-vscode-panel-border">
							<td className="py-1 pr-3 text-vscode-descriptionForeground">Verification Engine</td>
							<td className="py-1 text-right font-medium">
								{status.verificationEngine.lastVerifyAt
									? new Date(status.verificationEngine.lastVerifyAt as number).toLocaleTimeString()
									: status.verificationEngine.enabled
										? "Active"
										: "Inactive"}
							</td>
						</tr>
					)}
					{/* Requirements Verification sub-status */}
					{status.requirementsVerification && (
						<tr className="border-b border-vscode-panel-border">
							<td className="py-1 pr-3 text-vscode-descriptionForeground">Requirements Verification</td>
							<td className="py-1 text-right font-medium">
								{status.requirementsVerification.activeCount !== undefined
									? `${status.requirementsVerification.activeCount} active`
									: status.requirementsVerification.enabled
										? "Active"
										: "Inactive"}
							</td>
						</tr>
					)}
				</tbody>
			</table>
		</div>
	)
}
