import React, { useEffect, useMemo, useRef, useState } from "react"
import { Cable, Edit, Globe, Plus, Trash2, TriangleAlert, X } from "lucide-react"

import {
	hookDefinitionSchema,
	hookDefinitionsSchema,
	toolNames,
	type HookDefinition,
	type HookPhase,
	type ToolName,
} from "@roo-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
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
	Checkbox,
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
	StandardTooltip,
} from "@/components/ui"

import { SearchableSetting } from "./SearchableSetting"
import { SectionHeader } from "./SectionHeader"

type HookDraft = {
	id: string
	name: string
	enabled: boolean
	phase: HookPhase
	toolMatcher: ToolName[]
	executable: string
	argv: string[]
}

type HooksSettingsProps = {
	hookDefinitions: HookDefinition[]
	onChange: (definitions: HookDefinition[]) => void
	setErrorMessage: (message: string | undefined) => void
}

const createDraft = (): HookDraft => ({
	id: crypto.randomUUID(),
	name: "",
	enabled: false,
	phase: "sessionStart",
	toolMatcher: [],
	executable: "",
	argv: [],
})

const toDefinition = (draft: HookDraft): unknown =>
	draft.phase === "preToolUse"
		? { ...draft, toolMatcher: draft.toolMatcher }
		: {
				id: draft.id,
				name: draft.name,
				enabled: draft.enabled,
				phase: draft.phase,
				executable: draft.executable,
				argv: draft.argv,
			}

export const HooksSettings: React.FC<HooksSettingsProps> = ({ hookDefinitions, onChange, setErrorMessage }) => {
	const { t } = useAppTranslation()
	const [editorOpen, setEditorOpen] = useState(false)
	const [draft, setDraft] = useState<HookDraft>(createDraft)
	const [editingId, setEditingId] = useState<string>()
	const [deleteId, setDeleteId] = useState<string>()
	const ownsError = useRef(false)

	const draftResult = useMemo(() => hookDefinitionSchema.safeParse(toDefinition(draft)), [draft])
	const draftIsExact =
		draftResult.success && draftResult.data.name === draft.name && draftResult.data.executable === draft.executable
	const definitionsResult = useMemo(() => hookDefinitionsSchema.safeParse(hookDefinitions), [hookDefinitions])
	const validationMessage = !definitionsResult.success
		? definitionsResult.error.issues[0]?.message
		: editorOpen && !draftIsExact
			? draftResult.success
				? "Name and executable must not have leading or trailing whitespace"
				: draftResult.error.issues[0]?.message
			: undefined

	useEffect(() => {
		if (validationMessage) {
			ownsError.current = true
			setErrorMessage(t("settings:hooks.validation.invalid", { message: validationMessage }))
		} else if (ownsError.current) {
			ownsError.current = false
			setErrorMessage(undefined)
		}
	}, [setErrorMessage, t, validationMessage])

	useEffect(
		() => () => {
			if (ownsError.current) setErrorMessage(undefined)
		},
		[setErrorMessage],
	)

	const openAdd = () => {
		setEditingId(undefined)
		setDraft(createDraft())
		setEditorOpen(true)
	}

	const openEdit = (definition: HookDefinition) => {
		setEditingId(definition.id)
		setDraft({
			...definition,
			toolMatcher: definition.phase === "preToolUse" ? [...definition.toolMatcher] : [],
			argv: [...definition.argv],
		})
		setEditorOpen(true)
	}

	const saveDraft = () => {
		if (!draftResult.success || !draftIsExact) return
		const definition = draftResult.data
		onChange(
			editingId
				? hookDefinitions.map((item) => (item.id === editingId ? definition : item))
				: [...hookDefinitions, definition],
		)
		setEditorOpen(false)
	}

	const toggleTool = (tool: ToolName, checked: boolean) => {
		setDraft((current) => ({
			...current,
			toolMatcher: checked ? [...current.toolMatcher, tool] : current.toolMatcher.filter((item) => item !== tool),
		}))
	}

	return (
		<div className="flex flex-col h-full overflow-hidden">
			<div className="flex-shrink-0">
				<SectionHeader>{t("settings:sections.hooks")}</SectionHeader>
				<div className="flex flex-col gap-3 px-5 py-2">
					<SearchableSetting
						settingId="hooks-overview"
						section="hooks"
						label={t("settings:hooks.description")}>
						<p className="text-vscode-descriptionForeground text-sm m-0">
							{t("settings:hooks.description")}
						</p>
					</SearchableSetting>
					<SearchableSetting
						settingId="hooks-security"
						section="hooks"
						label={t("settings:hooks.securityWarning")}>
						<div className="flex gap-2 rounded border border-vscode-inputValidation-warningBorder bg-vscode-inputValidation-warningBackground p-2 text-sm">
							<TriangleAlert className="size-4 shrink-0 mt-0.5" />
							<span>{t("settings:hooks.securityWarning")}</span>
						</div>
					</SearchableSetting>
					<Button variant="secondary" className="py-1" onClick={openAdd} data-testid="add-hook">
						<Plus />
						{t("settings:hooks.add")}
					</Button>
				</div>
			</div>

			<SearchableSetting
				settingId="hooks-definitions"
				section="hooks"
				label={t("settings:hooks.search.definitions")}
				className="flex-1 overflow-y-auto px-4 py-2 min-h-0">
				<div className="flex items-center gap-2 px-2 py-2 mt-2">
					<Globe className="size-4 shrink-0" />
					<span className="font-medium text-lg">{t("settings:hooks.global")}</span>
				</div>
				{hookDefinitions.length === 0 ? (
					<div className="px-2 pb-4 text-sm text-vscode-descriptionForeground">
						{t("settings:hooks.empty")}
					</div>
				) : (
					hookDefinitions.map((definition) => (
						<div key={definition.id} className="p-2.5 px-2 rounded-xl border border-transparent">
							<div className="flex items-start justify-between gap-2 flex-col min-[400px]:flex-row overflow-hidden">
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-2 overflow-hidden">
										<span className="font-medium truncate">{definition.name}</span>
										<span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-vscode-badge-background text-vscode-badge-foreground shrink-0">
											{t(`settings:hooks.phase.${definition.phase}`)}
										</span>
										<span className="text-xs text-vscode-descriptionForeground shrink-0">
											{definition.enabled
												? t("settings:hooks.enabled")
												: t("settings:hooks.disabled")}
										</span>
									</div>
									{definition.phase === "preToolUse" && (
										<div className="text-xs text-vscode-descriptionForeground mt-1 truncate">
											{definition.toolMatcher.join(", ")}
										</div>
									)}
									<div className="text-xs text-vscode-descriptionForeground mt-1 truncate font-mono">
										{[definition.executable, ...definition.argv].join(" ")}
									</div>
								</div>
								<div className="flex items-center gap-1 flex-shrink-0">
									<StandardTooltip content={t("settings:hooks.edit")}>
										<Button variant="ghost" size="icon" onClick={() => openEdit(definition)}>
											<Edit />
										</Button>
									</StandardTooltip>
									<StandardTooltip content={t("settings:hooks.delete")}>
										<Button variant="ghost" size="icon" onClick={() => setDeleteId(definition.id)}>
											<Trash2 className="text-destructive" />
										</Button>
									</StandardTooltip>
								</div>
							</div>
						</div>
					))
				)}
			</SearchableSetting>

			<SearchableSetting
				settingId="hooks-command-format"
				section="hooks"
				label={t("settings:hooks.search.commandFormat")}>
				<div className="px-6 py-1 text-sm border-t border-vscode-panel-border text-muted-foreground flex items-center gap-2">
					<Cable className="size-3.5 shrink-0" />
					<span>{t("settings:hooks.footer")}</span>
				</div>
			</SearchableSetting>

			<Dialog open={editorOpen} onOpenChange={setEditorOpen}>
				<DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>
							{editingId ? t("settings:hooks.dialog.editTitle") : t("settings:hooks.dialog.addTitle")}
						</DialogTitle>
						<DialogDescription>{t("settings:hooks.dialog.description")}</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-4">
						<label className="flex flex-col gap-1">
							<span>{t("settings:hooks.fields.name")}</span>
							<Input
								value={draft.name}
								onChange={(event) => setDraft({ ...draft, name: event.target.value })}
								data-testid="hook-name"
							/>
						</label>
						<label className="flex flex-col gap-1">
							<span>{t("settings:hooks.fields.phase")}</span>
							<Select
								value={draft.phase}
								onValueChange={(phase: HookPhase) => setDraft({ ...draft, phase })}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="sessionStart">
										{t("settings:hooks.phase.sessionStart")}
									</SelectItem>
									<SelectItem value="preToolUse">{t("settings:hooks.phase.preToolUse")}</SelectItem>
								</SelectContent>
							</Select>
						</label>
						{draft.phase === "preToolUse" && (
							<fieldset className="flex flex-col gap-1 border-0 p-0 m-0">
								<legend>{t("settings:hooks.fields.tools")}</legend>
								<p className="text-xs text-vscode-descriptionForeground m-0">
									{t("settings:hooks.fields.toolsHint")}
								</p>
								<div className="grid grid-cols-2 gap-1 max-h-40 overflow-y-auto">
									{toolNames.map((tool) => (
										<label key={tool} className="flex items-center gap-2 font-mono text-xs">
											<Checkbox
												checked={draft.toolMatcher.includes(tool)}
												onCheckedChange={(checked) => toggleTool(tool, checked === true)}
											/>
											{tool}
										</label>
									))}
								</div>
							</fieldset>
						)}
						<label className="flex flex-col gap-1">
							<span>{t("settings:hooks.fields.executable")}</span>
							<Input
								value={draft.executable}
								onChange={(event) => setDraft({ ...draft, executable: event.target.value })}
								data-testid="hook-executable"
							/>
							<span className="text-xs text-vscode-descriptionForeground">
								{t("settings:hooks.fields.executableHint")}
							</span>
						</label>
						<fieldset className="flex flex-col gap-2 border-0 p-0 m-0">
							<legend>{t("settings:hooks.fields.arguments")}</legend>
							<p className="text-xs text-vscode-descriptionForeground m-0">
								{t("settings:hooks.fields.argumentsHint")}
							</p>
							{draft.argv.map((argument, index) => (
								<div key={index} className="flex gap-1">
									<Input
										className="font-mono flex-1"
										value={argument}
										aria-label={t("settings:hooks.fields.argument", { number: index + 1 })}
										onChange={(event) =>
											setDraft({
												...draft,
												argv: draft.argv.map((item, itemIndex) =>
													itemIndex === index ? event.target.value : item,
												),
											})
										}
									/>
									<Button
										variant="ghost"
										size="icon"
										onClick={() =>
											setDraft({
												...draft,
												argv: draft.argv.filter((_, itemIndex) => itemIndex !== index),
											})
										}>
										<X />
									</Button>
								</div>
							))}
							<Button
								variant="secondary"
								onClick={() => setDraft({ ...draft, argv: [...draft.argv, ""] })}>
								{t("settings:hooks.fields.addArgument")}
							</Button>
						</fieldset>
						<label className="flex items-center gap-2">
							<Checkbox
								checked={draft.enabled}
								onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked === true })}
								data-testid="hook-enabled"
							/>
							{t("settings:hooks.fields.enabled")}
						</label>
						{validationMessage && (
							<p className="text-vscode-errorForeground text-sm m-0" role="alert">
								{t("settings:hooks.validation.invalid", { message: validationMessage })}
							</p>
						)}
					</div>
					<DialogFooter>
						<Button variant="secondary" onClick={() => setEditorOpen(false)}>
							{t("settings:common.cancel")}
						</Button>
						<Button onClick={saveDraft} disabled={!draftIsExact} data-testid="save-hook">
							{editingId ? t("settings:hooks.dialog.update") : t("settings:hooks.dialog.add")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<AlertDialog open={Boolean(deleteId)} onOpenChange={(open) => !open && setDeleteId(undefined)}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("settings:hooks.deleteDialog.title")}</AlertDialogTitle>
						<AlertDialogDescription>{t("settings:hooks.deleteDialog.description")}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel onClick={() => setDeleteId(undefined)}>
							{t("settings:common.cancel")}
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								onChange(hookDefinitions.filter(({ id }) => id !== deleteId))
								setDeleteId(undefined)
							}}>
							{t("settings:hooks.delete")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
