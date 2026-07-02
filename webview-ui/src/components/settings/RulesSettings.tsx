import React, { useCallback, useEffect, useMemo, useState } from "react"
import { Edit, Folder, Globe, Plus, ScrollText, Trash2 } from "lucide-react"

import type { RuleMetadata } from "@roo-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	Button,
	StandardTooltip,
} from "@/components/ui"
import { vscode } from "@/utils/vscode"

import { SectionHeader } from "./SectionHeader"
import { CreateRuleDialog } from "./CreateRuleDialog"

export const RulesSettings: React.FC = () => {
	const { t } = useAppTranslation()
	const { cwd, rules: rawRules } = useExtensionState()
	const rules = useMemo(() => rawRules ?? [], [rawRules])

	const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
	const [ruleToDelete, setRuleToDelete] = useState<RuleMetadata | null>(null)
	const [createDialogOpen, setCreateDialogOpen] = useState(false)

	const hasWorkspace = Boolean(cwd)

	const handleRefresh = useCallback(() => {
		vscode.postMessage({ type: "requestRules" })
	}, [])

	useEffect(() => {
		handleRefresh()
	}, [handleRefresh])

	const handleDeleteClick = useCallback((rule: RuleMetadata) => {
		setRuleToDelete(rule)
		setDeleteDialogOpen(true)
	}, [])

	const handleDeleteConfirm = useCallback(() => {
		if (ruleToDelete) {
			vscode.postMessage({
				type: "deleteRule",
				values: {
					id: ruleToDelete.id,
					scope: ruleToDelete.scope,
					kind: ruleToDelete.kind,
					modeSlug: ruleToDelete.modeSlug,
					relativePath: ruleToDelete.relativePath,
				},
			})
			setDeleteDialogOpen(false)
			setRuleToDelete(null)
		}
	}, [ruleToDelete])

	const handleDeleteCancel = useCallback(() => {
		setDeleteDialogOpen(false)
		setRuleToDelete(null)
	}, [])

	const handleEditClick = useCallback((rule: RuleMetadata) => {
		vscode.postMessage({
			type: "openRuleFile",
			values: {
				id: rule.id,
				scope: rule.scope,
				kind: rule.kind,
				modeSlug: rule.modeSlug,
				relativePath: rule.relativePath,
			},
		})
	}, [])

	const handleRuleCreated = useCallback(() => {}, [])

	const projectRules = useMemo(() => rules.filter((rule) => rule.scope === "project"), [rules])
	const globalRules = useMemo(() => rules.filter((rule) => rule.scope === "global"), [rules])

	const renderRuleItem = useCallback(
		(rule: RuleMetadata) => (
			<div key={rule.id} className="p-2.5 px-2 rounded-xl border border-transparent">
				<div className="flex items-start justify-between gap-2 flex-col min-[400px]:flex-row overflow-hidden">
					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-2 overflow-hidden">
							<span className="font-medium truncate">{rule.name}</span>
							<span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-vscode-badge-background text-vscode-badge-foreground shrink-0">
								{rule.kind === "mode"
									? t("settings:rules.kind.modeBadge")
									: t("settings:rules.kind.genericBadge")}
							</span>
						</div>
						<div className="text-xs text-vscode-descriptionForeground mt-1 truncate">
							{rule.relativePath}
						</div>
						{rule.kind === "mode" && (
							<div className="text-xs text-vscode-descriptionForeground mt-1">
								{t("settings:rules.modeLabel", { mode: rule.modeName ?? rule.modeSlug })}
							</div>
						)}
					</div>

					<div className="flex items-center gap-1 px-0 ml-0 min-[400px]:ml-0 min-[400px]:mt-2 flex-shrink-0">
						<StandardTooltip content={t("settings:rules.editRule")}>
							<Button variant="ghost" size="icon" onClick={() => handleEditClick(rule)}>
								<Edit />
							</Button>
						</StandardTooltip>
						<StandardTooltip content={t("settings:rules.deleteRule")}>
							<Button variant="ghost" size="icon" onClick={() => handleDeleteClick(rule)}>
								<Trash2 className="text-destructive" />
							</Button>
						</StandardTooltip>
					</div>
				</div>
			</div>
		),
		[t, handleDeleteClick, handleEditClick],
	)

	return (
		<div className="flex flex-col h-full overflow-hidden">
			<div className="flex-shrink-0">
				<SectionHeader>{t("settings:sections.rules")}</SectionHeader>
				<div className="flex flex-col gap-2 px-5 py-2">
					<p className="text-vscode-descriptionForeground text-sm m-0">{t("settings:rules.description")}</p>
					<Button variant="secondary" className="py-1" onClick={() => setCreateDialogOpen(true)}>
						<Plus />
						{t("settings:rules.addRule")}
					</Button>
				</div>
			</div>

			<div className="flex-1 overflow-y-auto px-4 py-2 min-h-0">
				<div className="flex flex-col gap-1">
					{hasWorkspace && (
						<>
							<div className="flex items-center gap-2 px-2 py-2 mt-2 cursor-default">
								<Folder className="size-4 shrink-0" />
								<span className="font-medium text-lg">{t("settings:rules.workspaceRules")}</span>
							</div>
							{projectRules.length > 0 ? (
								projectRules.map(renderRuleItem)
							) : (
								<div className="px-2 pb-4 text-sm text-vscode-descriptionForeground cursor-default">
									{t("settings:rules.noWorkspaceRules")}
								</div>
							)}
						</>
					)}

					<div className="flex items-center gap-2 px-2 py-2 mt-2 cursor-default">
						<Globe className="size-4 shrink-0" />
						<span className="font-medium text-lg">{t("settings:rules.globalRules")}</span>
					</div>
					{globalRules.length > 0 ? (
						globalRules.map(renderRuleItem)
					) : (
						<div className="px-2 pb-4 text-sm text-vscode-descriptionForeground cursor-default">
							{t("settings:rules.noGlobalRules")}
						</div>
					)}
				</div>
			</div>

			<div className="px-6 py-1 text-sm border-t border-vscode-panel-border text-muted-foreground flex items-center gap-2">
				<ScrollText className="size-3.5 shrink-0" />
				<span>{t("settings:rules.footer")}</span>
			</div>

			<AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("settings:rules.deleteDialog.title")}</AlertDialogTitle>
						<AlertDialogDescription>
							{t("settings:rules.deleteDialog.description", { name: ruleToDelete?.name })}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel onClick={handleDeleteCancel}>
							{t("settings:rules.deleteDialog.cancel")}
						</AlertDialogCancel>
						<AlertDialogAction onClick={handleDeleteConfirm}>
							{t("settings:rules.deleteDialog.confirm")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<CreateRuleDialog
				open={createDialogOpen}
				onOpenChange={setCreateDialogOpen}
				onRuleCreated={handleRuleCreated}
				hasWorkspace={hasWorkspace}
			/>
		</div>
	)
}
