import { useState } from "react"
import type { ProviderSettingsEntry } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"

import { SearchableSetting } from "./SearchableSetting"
import { SetCachedStateField } from "./types"

// Sentinel for "no dedicated profile" - Select cannot hold an empty string as a value.
const USE_CURRENT_CONFIG = "-"

// A sibling <label> does not name the Radix trigger, so the two are linked explicitly.
const LABEL_ID = "commit-message-model-label"

// Kept in step with `commitMessageTimeout` in the settings schema, which rejects anything outside
// this range, and with `DEFAULT_COMMIT_MESSAGE_TIMEOUT_SECONDS` in the extension host.
const MIN_TIMEOUT_SECONDS = 10
const MAX_TIMEOUT_SECONDS = 600
const DEFAULT_TIMEOUT_SECONDS = 60

interface CommitMessageModelSelectProps {
	listApiConfigMeta: ProviderSettingsEntry[]
	commitMessageApiConfigId?: string
	commitMessageTimeout?: number
	setCachedStateField: SetCachedStateField<"commitMessageApiConfigId" | "commitMessageTimeout">
}

/**
 * Picks the API configuration profile used to generate Git commit messages from the Source Control
 * panel. Leaving it unset uses whichever profile is currently active.
 */
export const CommitMessageModelSelect = ({
	listApiConfigMeta,
	commitMessageApiConfigId,
	commitMessageTimeout,
	setCachedStateField,
}: CommitMessageModelSelectProps) => {
	const { t } = useAppTranslation()

	// Only the text that cannot be stored is kept locally: an empty field, or a half-typed number
	// below the minimum on its way to a longer one. Anything valid goes straight to cached state,
	// so the input follows it like every other setting in this panel rather than shadowing it -
	// a local copy would keep showing the old number after a save until the view remounted.
	const [invalidDraft, setInvalidDraft] = useState<string | null>(null)

	// A saved id outlives the profile it points at. Radix renders a blank trigger when the value
	// matches no item, so an id that is no longer known falls back to the "use current" option.
	const selectedValue = listApiConfigMeta.some(({ id }) => id === commitMessageApiConfigId)
		? commitMessageApiConfigId
		: USE_CURRENT_CONFIG

	return (
		<SearchableSetting
			settingId="commit-message-model"
			section="providers"
			label={t("settings:providers.commitMessageModel.label")}
			className="mt-4">
			<label id={LABEL_ID} className="block font-medium mb-1">
				{t("settings:providers.commitMessageModel.label")}
			</label>
			<Select
				value={selectedValue}
				onValueChange={(value) =>
					setCachedStateField("commitMessageApiConfigId", value === USE_CURRENT_CONFIG ? "" : value)
				}>
				<SelectTrigger aria-labelledby={LABEL_ID} data-testid="commit-message-model-select" className="w-full">
					<SelectValue placeholder={t("settings:providers.commitMessageModel.useCurrentConfig")} />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={USE_CURRENT_CONFIG}>
						{t("settings:providers.commitMessageModel.useCurrentConfig")}
					</SelectItem>
					{listApiConfigMeta.map((config) => (
						<SelectItem key={config.id} value={config.id} data-testid={`${config.id}-option`}>
							{config.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<div className="text-sm text-vscode-descriptionForeground mt-1">
				{t("settings:providers.commitMessageModel.description")}
			</div>
			<div className="flex flex-col gap-2 mt-3">
				<label htmlFor="commit-message-timeout" className="font-medium">
					{t("settings:providers.commitMessageTimeout.label")}
				</label>
				<Input
					id="commit-message-timeout"
					type="number"
					pattern="[0-9]*"
					className="w-24 bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border px-2 py-1 rounded text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
					value={invalidDraft ?? String(commitMessageTimeout ?? DEFAULT_TIMEOUT_SECONDS)}
					min={MIN_TIMEOUT_SECONDS}
					max={MAX_TIMEOUT_SECONDS}
					data-testid="commit-message-timeout"
					onChange={(e) => {
						// Commit every value the schema would accept as it is typed, so Save picks
						// it up whether or not the field was blurred first.
						//
						// `Number` rather than `parseInt`: parsing stops at the first character it
						// cannot use, so "23.5" and "12abc" would quietly store 23 and 12 while the
						// field still showed what was typed. The schema takes integers only, so
						// anything fractional stays an unstorable draft instead.
						const seconds = Number(e.target.value)
						const storable =
							e.target.value.trim() !== "" &&
							Number.isInteger(seconds) &&
							seconds >= MIN_TIMEOUT_SECONDS &&
							seconds <= MAX_TIMEOUT_SECONDS

						if (storable) {
							setInvalidDraft(null)
							setCachedStateField("commitMessageTimeout", seconds)
						} else {
							setInvalidDraft(e.target.value)
						}
					}}
					// Leaving the field mid-edit drops the unstorable text, so the input falls back
					// to the value that was actually saved.
					onBlur={() => setInvalidDraft(null)}
				/>
				<div className="text-sm text-vscode-descriptionForeground">
					{t("settings:providers.commitMessageTimeout.description")}
				</div>
			</div>
		</SearchableSetting>
	)
}
