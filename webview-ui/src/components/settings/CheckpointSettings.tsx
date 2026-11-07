import { HTMLAttributes, type FormEvent } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { VSCodeCheckbox, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { Trans } from "react-i18next"
import { buildDocLink } from "@src/utils/docLinks"
import { Slider } from "@/components/ui"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import {
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	MAX_CHECKPOINT_TIMEOUT_SECONDS,
	MIN_CHECKPOINT_TIMEOUT_SECONDS,
	DEFAULT_PER_WRITE_CHECKPOINTS,
	DEFAULT_CHANGE_CARD_DETAIL,
	type ChangeCardDetail,
} from "@roo-code/types"

/**
 * The `checked` state of a VSCodeCheckbox change event. The real toolkit
 * dispatches a native `Event` whose current target is the web component;
 * the test mock forwards a synthetic event on the underlying input. Both
 * expose a boolean `checked` on the current target.
 */
type CheckboxEventTarget = { checked?: boolean }

type CheckpointSettingsProps = HTMLAttributes<HTMLDivElement> & {
	enableCheckpoints?: boolean
	checkpointTimeout?: number
	perWriteCheckpoints?: boolean
	changeCardDetail?: ChangeCardDetail
	setCachedStateField: SetCachedStateField<
		"enableCheckpoints" | "checkpointTimeout" | "perWriteCheckpoints" | "changeCardDetail"
	>
}

export const CheckpointSettings = ({
	enableCheckpoints,
	checkpointTimeout,
	perWriteCheckpoints,
	changeCardDetail,
	setCachedStateField,
	...props
}: CheckpointSettingsProps) => {
	const { t } = useAppTranslation()
	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.checkpoints")}</SectionHeader>

			<Section>
				<SearchableSetting
					settingId="checkpoints-perWriteCheckpoints"
					section="checkpoints"
					label={t("settings:checkpoints.perWrite.label")}>
					<VSCodeCheckbox
						data-testid="per-write-checkbox"
						checked={perWriteCheckpoints ?? DEFAULT_PER_WRITE_CHECKPOINTS}
						onChange={(e: Event | FormEvent<HTMLElement>) => {
							const target = e.currentTarget as CheckboxEventTarget | null
							setCachedStateField("perWriteCheckpoints", target?.checked === true)
						}}>
						<span className="font-medium">{t("settings:checkpoints.perWrite.label")}</span>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:checkpoints.perWrite.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="checkpoints-changeCardDetail"
					section="checkpoints"
					label={t("settings:checkpoints.changeCardDetail.label")}>
					<VSCodeCheckbox
						checked={(changeCardDetail ?? DEFAULT_CHANGE_CARD_DETAIL) === "full"}
						onChange={(e: Event | FormEvent<HTMLElement>) => {
							const target = e.currentTarget as CheckboxEventTarget | null
							setCachedStateField("changeCardDetail", target?.checked === true ? "full" : "summary")
						}}
						data-testid="change-card-detail-checkbox">
						<span className="font-medium">{t("settings:checkpoints.changeCardDetail.label")}</span>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:checkpoints.changeCardDetail.description")}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="checkpoints-enable"
					section="checkpoints"
					label={t("settings:checkpoints.enable.label")}>
					<VSCodeCheckbox
						checked={enableCheckpoints}
						onChange={(e: Event | FormEvent<HTMLElement>) => {
							const target = e.currentTarget as CheckboxEventTarget | null
							setCachedStateField("enableCheckpoints", target?.checked === true)
						}}>
						<span className="font-medium">{t("settings:checkpoints.enable.label")}</span>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						<Trans i18nKey="settings:checkpoints.enable.description">
							<VSCodeLink
								href={buildDocLink("features/checkpoints", "settings_checkpoints")}
								style={{ display: "inline" }}>
								{" "}
							</VSCodeLink>
						</Trans>
					</div>
				</SearchableSetting>

				{enableCheckpoints && (
					<SearchableSetting
						settingId="checkpoints-timeout"
						section="checkpoints"
						label={t("settings:checkpoints.timeout.label")}
						className="mt-4">
						<label className="block text-sm font-medium mb-2">
							{t("settings:checkpoints.timeout.label")}
						</label>
						<div className="flex items-center gap-2">
							<Slider
								min={MIN_CHECKPOINT_TIMEOUT_SECONDS}
								max={MAX_CHECKPOINT_TIMEOUT_SECONDS}
								step={1}
								defaultValue={[checkpointTimeout ?? DEFAULT_CHECKPOINT_TIMEOUT_SECONDS]}
								onValueChange={([value]) => {
									setCachedStateField("checkpointTimeout", value)
								}}
								className="flex-1"
								data-testid="checkpoint-timeout-slider"
							/>
							<span className="w-12 text-center">
								{checkpointTimeout ?? DEFAULT_CHECKPOINT_TIMEOUT_SECONDS}
							</span>
						</div>
						<div className="text-vscode-descriptionForeground text-sm mt-1">
							{t("settings:checkpoints.timeout.description")}
						</div>
					</SearchableSetting>
				)}
			</Section>
		</div>
	)
}
