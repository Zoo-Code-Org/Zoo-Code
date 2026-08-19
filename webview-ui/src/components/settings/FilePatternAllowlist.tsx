import { VSCodeTextArea } from "@vscode/webview-ui-toolkit/react"

import { useAppTranslation } from "@/i18n/TranslationContext"

import { SetCachedStateField } from "./types"
import { SearchableSetting } from "./SearchableSetting"

type AllowlistField = "allowedReadFiles" | "allowedWriteFiles"

interface FilePatternAllowlistProps {
	/** Setting the patterns are buffered into. */
	field: AllowlistField
	/** Key under `settings:autoApprove.allowlists` holding this list's strings. */
	translationKey: "readFiles" | "writeFiles"
	/** Id this list is registered under in the settings search index. */
	settingId: string
	/** Prefix for this list's `data-testid`s, so the two lists stay distinguishable. */
	testIdPrefix: string
	patterns?: string[]
	setCachedStateField: SetCachedStateField<AllowlistField>
}

/**
 * An editable list of gitignore-style file patterns granting one kind of
 * auto-approved access.
 *
 * Edited as text, one pattern per line, because the order of the lines is
 * meaningful: as in a `.gitignore` file, a later pattern overrides an earlier
 * one, which a set of individually-added chips could not express. It also lets a
 * list be pasted in or copied out in one go.
 *
 * Blank lines are kept while editing so that a line can be cleared without the
 * cursor jumping; they are dropped when the settings are saved.
 *
 * The pattern syntax itself is explained once by the enclosing Allowlists
 * section, so each list only carries what is specific to it.
 */
export const FilePatternAllowlist = ({
	field,
	translationKey,
	settingId,
	testIdPrefix,
	patterns,
	setCachedStateField,
}: FilePatternAllowlistProps) => {
	const { t } = useAppTranslation()

	const label = t(`settings:autoApprove.allowlists.${translationKey}.label`)

	return (
		<SearchableSetting settingId={settingId} section="autoApprove" label={label}>
			<label className="block font-medium mb-1" data-testid={`${testIdPrefix}s-heading`}>
				{label}
			</label>
			<div className="text-vscode-descriptionForeground text-sm mt-1 mb-2">
				{t(`settings:autoApprove.allowlists.${translationKey}.description`)}
			</div>
			<VSCodeTextArea
				resize="vertical"
				rows={4}
				value={(patterns ?? []).join("\n")}
				onInput={(e: any) => setCachedStateField(field, (e.target?.value ?? "").split("\n"))}
				placeholder={t(`settings:autoApprove.allowlists.${translationKey}.placeholder`)}
				className="w-full"
				data-testid={`${testIdPrefix}-input`}
			/>
		</SearchableSetting>
	)
}
