import { useState } from "react"
import { Check, Pencil, Plus, Trash2, X } from "lucide-react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import { AUTOCOMPLETE_PROFILE_LIMITS, type AutocompleteProfile } from "@roo-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"

import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, StandardTooltip } from "../../ui"

export interface AutocompleteProfileBarProps {
	profiles: AutocompleteProfile[]
	activeProfileId?: string
	/** True when the live config differs from the saved profile it was loaded from. */
	isDirty: boolean
	onSelect: (profileId: string) => void
	onSave: (name: string) => void
	onRename: (profileId: string, name: string) => void
	onDelete: (profileId: string) => void
}

/**
 * Named-preset bar for autocomplete, modelled on the Providers tab's configuration
 * profile row but deliberately lighter: a completion preset is just a name plus the
 * config object, with no per-profile secret and no cross-mode binding.
 *
 * The common case is two presets — a fast local model and a stronger cloud one —
 * so the affordances optimise for switching, not for management.
 */
export const AutocompleteProfileBar = ({
	profiles,
	activeProfileId,
	isDirty,
	onSelect,
	onSave,
	onRename,
	onDelete,
}: AutocompleteProfileBarProps) => {
	const { t } = useAppTranslation()

	const [draftName, setDraftName] = useState<string | null>(null)
	const [isRenaming, setIsRenaming] = useState(false)

	const activeProfile = profiles.find((profile) => profile.id === activeProfileId)
	const atLimit = profiles.length >= AUTOCOMPLETE_PROFILE_LIMITS.MAX_PROFILES

	const beginCreate = () => {
		setIsRenaming(false)
		setDraftName("")
	}

	const beginRename = () => {
		setIsRenaming(true)
		setDraftName(activeProfile?.name ?? "")
	}

	const cancel = () => {
		setDraftName(null)
		setIsRenaming(false)
	}

	const commit = () => {
		const name = (draftName ?? "").trim()

		if (name.length === 0) {
			return
		}

		if (isRenaming && activeProfile) {
			onRename(activeProfile.id, name)
		} else {
			onSave(name)
		}

		cancel()
	}

	if (draftName !== null) {
		return (
			<div className="flex items-end gap-2" data-testid="autocomplete-profile-editor">
				<div className="flex-1">
					<label className="block font-medium mb-1">
						{isRenaming
							? t("settings:autocomplete.profiles.renameLabel")
							: t("settings:autocomplete.profiles.saveLabel")}
					</label>
					<VSCodeTextField
						value={draftName}
						maxlength={AUTOCOMPLETE_PROFILE_LIMITS.NAME_MAX}
						placeholder={t("settings:autocomplete.profiles.namePlaceholder")}
						className="w-full"
						data-testid="autocomplete-profile-name-input"
						onInput={(e: unknown) => setDraftName((e as { target: { value: string } }).target.value)}
						onKeyDown={(e: unknown) => {
							const event = e as { key: string }

							if (event.key === "Enter") {
								commit()
							} else if (event.key === "Escape") {
								cancel()
							}
						}}
					/>
				</div>
				<StandardTooltip content={t("settings:autocomplete.profiles.confirm")}>
					<Button
						variant="ghost"
						size="icon"
						disabled={(draftName ?? "").trim().length === 0}
						onClick={commit}
						data-testid="autocomplete-profile-confirm">
						<Check className="size-4" />
					</Button>
				</StandardTooltip>
				<StandardTooltip content={t("settings:autocomplete.profiles.cancel")}>
					<Button variant="ghost" size="icon" onClick={cancel} data-testid="autocomplete-profile-cancel">
						<X className="size-4" />
					</Button>
				</StandardTooltip>
			</div>
		)
	}

	return (
		<div className="flex flex-col gap-1">
			<label className="block font-medium mb-1">{t("settings:autocomplete.profiles.label")}</label>
			<div className="flex items-center gap-2">
				<Select value={activeProfileId ?? ""} onValueChange={onSelect} disabled={profiles.length === 0}>
					<SelectTrigger className="flex-1" data-testid="autocomplete-profile-select">
						<SelectValue placeholder={t("settings:autocomplete.profiles.none")} />
					</SelectTrigger>
					<SelectContent>
						{profiles.map((profile) => (
							<SelectItem key={profile.id} value={profile.id}>
								{profile.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>

				<StandardTooltip
					content={
						atLimit
							? t("settings:autocomplete.profiles.limitReached")
							: t("settings:autocomplete.profiles.save")
					}>
					<Button
						variant="ghost"
						size="icon"
						disabled={atLimit}
						onClick={beginCreate}
						data-testid="autocomplete-profile-add">
						<Plus className="size-4" />
					</Button>
				</StandardTooltip>

				<StandardTooltip content={t("settings:autocomplete.profiles.rename")}>
					<Button
						variant="ghost"
						size="icon"
						disabled={!activeProfile}
						onClick={beginRename}
						data-testid="autocomplete-profile-rename">
						<Pencil className="size-4" />
					</Button>
				</StandardTooltip>

				<StandardTooltip content={t("settings:autocomplete.profiles.delete")}>
					<Button
						variant="ghost"
						size="icon"
						disabled={!activeProfile}
						onClick={() => activeProfile && onDelete(activeProfile.id)}
						data-testid="autocomplete-profile-delete">
						<Trash2 className="size-4" />
					</Button>
				</StandardTooltip>
			</div>

			<div className="text-vscode-descriptionForeground text-sm mt-1">
				{activeProfile && isDirty
					? t("settings:autocomplete.profiles.unsavedChanges", { name: activeProfile.name })
					: t("settings:autocomplete.profiles.description")}
			</div>
		</div>
	)
}
