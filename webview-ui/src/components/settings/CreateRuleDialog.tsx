import React, { useCallback, useMemo, useState } from "react"

import { getAllModes } from "@roo/modes"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui"
import { vscode } from "@/utils/vscode"

interface CreateRuleDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	onRuleCreated: () => void
	hasWorkspace: boolean
}

const validateRuleName = (name: string): string | null => {
	if (!name.trim()) return "settings:rules.validation.nameRequired"
	if (name.length > 64) return "settings:rules.validation.nameTooLong"
	if (!/^[a-z0-9_-]+$/.test(name)) return "settings:rules.validation.nameInvalid"
	return null
}

export const CreateRuleDialog: React.FC<CreateRuleDialogProps> = ({
	open,
	onOpenChange,
	onRuleCreated,
	hasWorkspace,
}) => {
	const { t } = useAppTranslation()
	const { customModes } = useExtensionState()

	const [name, setName] = useState("")
	const [scope, setScope] = useState<"global" | "project">(hasWorkspace ? "project" : "global")
	const [kind, setKind] = useState<"generic" | "mode">("generic")
	const [modeSlug, setModeSlug] = useState<string>("")
	const [nameError, setNameError] = useState<string | null>(null)
	const [modeError, setModeError] = useState<string | null>(null)

	const availableModes = useMemo(
		() => getAllModes(customModes).map((m) => ({ slug: m.slug, name: m.name })),
		[customModes],
	)

	const resetForm = useCallback(() => {
		setName("")
		setScope(hasWorkspace ? "project" : "global")
		setKind("generic")
		setModeSlug("")
		setNameError(null)
		setModeError(null)
	}, [hasWorkspace])

	const handleClose = useCallback(() => {
		resetForm()
		onOpenChange(false)
	}, [resetForm, onOpenChange])

	const handleNameChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
		const value = event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "")
		setName(value)
		setNameError(null)
	}, [])

	const handleKindChange = useCallback((value: string) => {
		const nextKind = value as "generic" | "mode"
		setKind(nextKind)
		setModeError(null)
		if (nextKind === "generic") {
			setModeSlug("")
		}
	}, [])

	const handleCreate = useCallback(() => {
		const nameValidationError = validateRuleName(name)
		if (nameValidationError) {
			setNameError(nameValidationError)
			return
		}

		if (kind === "mode" && !modeSlug) {
			setModeError("settings:rules.validation.modeRequired")
			return
		}

		const fileName = name.trim().endsWith(".md") ? name.trim() : `${name.trim()}.md`
		vscode.postMessage({
			type: "createRule",
			values: {
				scope,
				kind,
				modeSlug: kind === "mode" ? modeSlug : undefined,
				fileName,
			},
		})

		handleClose()
		onRuleCreated()
	}, [name, kind, modeSlug, scope, handleClose, onRuleCreated])

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) resetForm()
				onOpenChange(nextOpen)
			}}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{t("settings:rules.createDialog.title")}</DialogTitle>
					<DialogDescription></DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4">
					<div className="flex flex-col gap-1">
						<label htmlFor="rule-name" className="text-sm font-medium text-vscode-foreground">
							{t("settings:rules.createDialog.nameLabel")}
						</label>
						<Input
							id="rule-name"
							type="text"
							value={name}
							onChange={handleNameChange}
							placeholder={t("settings:rules.createDialog.namePlaceholder")}
							maxLength={64}
							className="w-full bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-vscode-focusBorder"
						/>
						<span className="text-xs text-vscode-descriptionForeground">
							{t("settings:rules.createDialog.nameHint")}
						</span>
						{nameError && <span className="text-xs text-vscode-errorForeground">{t(nameError)}</span>}
					</div>

					<div className="flex flex-col gap-1">
						<label className="text-sm font-medium text-vscode-foreground">
							{t("settings:rules.createDialog.scopeLabel")}
						</label>
						<Select value={scope} onValueChange={(value) => setScope(value as "global" | "project")}>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="global">{t("settings:rules.scope.global")}</SelectItem>
								{hasWorkspace && (
									<SelectItem value="project">{t("settings:rules.scope.project")}</SelectItem>
								)}
							</SelectContent>
						</Select>
					</div>

					<div className="flex flex-col gap-1">
						<label className="text-sm font-medium text-vscode-foreground">
							{t("settings:rules.createDialog.kindLabel")}
						</label>
						<Select value={kind} onValueChange={handleKindChange}>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="generic">{t("settings:rules.kind.generic")}</SelectItem>
								<SelectItem value="mode">{t("settings:rules.kind.mode")}</SelectItem>
							</SelectContent>
						</Select>
					</div>

					{kind === "mode" && (
						<div className="flex flex-col gap-1">
							<label className="text-sm font-medium text-vscode-foreground">
								{t("settings:rules.createDialog.modeLabel")}
							</label>
							<Select
								value={modeSlug}
								onValueChange={(value) => {
									setModeSlug(value)
									setModeError(null)
								}}>
								<SelectTrigger className="w-full">
									<SelectValue placeholder={t("settings:rules.createDialog.modePlaceholder")} />
								</SelectTrigger>
								<SelectContent>
									{availableModes.map((mode) => (
										<SelectItem key={mode.slug} value={mode.slug}>
											{mode.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{modeError && <span className="text-xs text-vscode-errorForeground">{t(modeError)}</span>}
						</div>
					)}
				</div>

				<DialogFooter>
					<Button variant="secondary" onClick={handleClose}>
						{t("settings:rules.createDialog.cancel")}
					</Button>
					<Button variant="primary" onClick={handleCreate} disabled={!name || (kind === "mode" && !modeSlug)}>
						{t("settings:rules.createDialog.create")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
