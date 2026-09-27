import type { FormEvent } from "react"
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
/**
 * Read the current text out of a `VSCodeTextArea`'s input event.
 *
 * The toolkit component wraps a native `<textarea>` in a custom element, whose
 * `value` is not part of `EventTarget`, so it is read through that element's own
 * interface rather than by casting the event to `any`. The event is typed as the
 * DOM `Event` the toolkit declares, which a React `FormEvent` also satisfies.
 */
function textareaValue(event: Event | FormEvent<HTMLElement>): string {
	const target = event.currentTarget as (HTMLElement & { value?: string }) | null

	return target?.value ?? ""
}

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
	const headingId = `${settingId}-label`
	const descriptionId = `${settingId}-description`

	return (
		<SearchableSetting settingId={settingId} section="autoApprove" label={label}>
			{/* The heading names the textarea rather than wrapping it: the toolkit
			    renders a custom element, which a native `<label for>` cannot reach.  */}
			<label id={headingId} className="block font-medium mb-1" data-testid={`${testIdPrefix}s-heading`}>
				{label}
			</label>
			<div id={descriptionId} className="text-vscode-descriptionForeground text-sm mt-1 mb-2">
				{t(`settings:autoApprove.allowlists.${translationKey}.description`)}
			</div>
			<VSCodeTextArea
				resize="vertical"
				rows={4}
				value={(patterns ?? []).join("\n")}
				onInput={(event) => setCachedStateField(field, textareaValue(event).split("\n"))}
				placeholder={t(`settings:autoApprove.allowlists.${translationKey}.placeholder`)}
				className="w-full"
				aria-labelledby={headingId}
				aria-describedby={descriptionId}
				data-testid={`${testIdPrefix}-input`}
			/>
		</SearchableSetting>
	)
}
