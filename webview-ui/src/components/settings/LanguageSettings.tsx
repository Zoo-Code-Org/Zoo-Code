import { FormEvent, HTMLAttributes } from "react"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group"

import { useAppTranslation } from "@/i18n/TranslationContext"

import type { Language } from "@roo-code/types"

import { LANGUAGES } from "@roo/language"

import { cn } from "@src/lib/utils"
import { formatDateOnly, formatDateTime, formatTimeOnly, type DateFormat, type TimeFormat } from "@src/utils/format"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"

const TIME_FORMATS: TimeFormat[] = ["auto", "12h", "24h"]
const DATE_FORMATS: DateFormat[] = ["auto", "mdy", "dmy", "ymd"]

// Fixed sample (Oct 27, 2026, 14:41 local) so the preview clearly shows 12h vs 24h and date order.
const SAMPLE_TS = new Date(2026, 9, 27, 14, 41, 0).getTime()

type LanguageSettingsProps = HTMLAttributes<HTMLDivElement> & {
	language: string
	timeFormat?: TimeFormat
	dateFormat?: DateFormat
	showRelativeTimes?: boolean
	setCachedStateField: SetCachedStateField<"language" | "timeFormat" | "dateFormat" | "showRelativeTimes">
}

export const LanguageSettings = ({
	language,
	timeFormat = "auto",
	dateFormat = "auto",
	showRelativeTimes = true,
	setCachedStateField,
	className,
	...props
}: LanguageSettingsProps) => {
	const { t } = useAppTranslation()

	// Three short Intl calls, computed on every render. They use the language selected above, not the
	// saved one, so "auto" previews the new language before Save.
	const preview = {
		chatTime: formatTimeOnly(SAMPLE_TS, timeFormat, language),
		dateExample: formatDateOnly(SAMPLE_TS, dateFormat, language),
		hover: formatDateTime(SAMPLE_TS, timeFormat, dateFormat, language),
	}

	return (
		<div className={cn("flex flex-col gap-2", className)} {...props}>
			<SectionHeader description={t("settings:language.description")}>
				{t("settings:sections.language")}
			</SectionHeader>

			<Section>
				<div className="flex flex-col gap-6">
					<div className="flex flex-col gap-3">
						<SubTitle>{t("settings:language.languageTitle")}</SubTitle>
						<SearchableSetting
							settingId="language-select"
							section="language"
							label={t("settings:sections.language")}>
							<div className="flex flex-col gap-1">
								<label className="font-medium">{t("settings:language.displayLanguage")}</label>
								<Select
									value={language}
									onValueChange={(value) => setCachedStateField("language", value as Language)}>
									<SelectTrigger className="w-full">
										<SelectValue placeholder={t("settings:common.select")} />
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											{Object.entries(LANGUAGES).map(([code, name]) => (
												<SelectItem key={code} value={code}>
													{name}
													<span className="text-muted-foreground">({code})</span>
												</SelectItem>
											))}
										</SelectGroup>
									</SelectContent>
								</Select>
								<div className="text-vscode-descriptionForeground text-sm">
									{t("settings:language.displayLanguageDescription")}
								</div>
							</div>
						</SearchableSetting>
					</div>

					<div className="flex flex-col gap-4">
						<SubTitle>{t("settings:language.dateTimeTitle")}</SubTitle>

						{/* Time format: segmented control, as in the design */}
						<SearchableSetting
							settingId="language-time-format"
							section="language"
							label={t("settings:language.timeFormat.label")}>
							<div className="flex flex-col gap-1.5">
								<label className="font-medium">{t("settings:language.timeFormat.label")}</label>
								{/* A radio group: one tab stop, the arrow keys move between the options and select them. */}
								<RadioGroupPrimitive.Root
									className="inline-flex self-start rounded-md border border-vscode-input-border overflow-hidden"
									value={timeFormat}
									onValueChange={(value) => setCachedStateField("timeFormat", value as TimeFormat)}
									orientation="horizontal"
									aria-label={t("settings:language.timeFormat.label")}
									data-testid="time-format-select">
									{TIME_FORMATS.map((format) => (
										<RadioGroupPrimitive.Item
											key={format}
											value={format}
											// Selection follows focus, as for any radio group: the arrow keys move the
											// focus, and the option that gets it is the selected one. Radix only does
											// this while the arrow key is still held when its focus move lands, so a
											// quick tap would otherwise leave the focus and the saved value apart.
											onFocus={() => {
												if (format !== timeFormat) setCachedStateField("timeFormat", format)
											}}
											data-testid={`time-format-${format}`}
											className={cn(
												"px-3 py-1 text-sm border-r border-vscode-input-border last:border-r-0 cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-vscode-focusBorder",
												format === timeFormat
													? "bg-vscode-button-background text-vscode-button-foreground"
													: "bg-vscode-input-background text-vscode-foreground hover:bg-vscode-list-hoverBackground",
											)}>
											{t(`settings:language.timeFormat.options.${format}`)}
										</RadioGroupPrimitive.Item>
									))}
								</RadioGroupPrimitive.Root>
								<div className="text-vscode-descriptionForeground text-sm">
									{t("settings:language.timeFormat.description")}
								</div>
							</div>
						</SearchableSetting>

						{/* Date format: select + live example */}
						<SearchableSetting
							settingId="language-date-format"
							section="language"
							label={t("settings:language.dateFormat.label")}>
							<div className="flex flex-col gap-1.5">
								<label htmlFor="date-format-select" className="font-medium">
									{t("settings:language.dateFormat.label")}
								</label>
								<div className="flex items-center gap-3">
									<Select
										value={dateFormat}
										onValueChange={(value) =>
											setCachedStateField("dateFormat", value as DateFormat)
										}>
										<SelectTrigger
											id="date-format-select"
											className="w-40"
											data-testid="date-format-select">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{DATE_FORMATS.map((format) => (
												<SelectItem key={format} value={format}>
													{t(`settings:language.dateFormat.options.${format}`)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<span
										className="text-vscode-descriptionForeground text-sm"
										data-testid="date-format-example">
										{t("settings:language.dateFormat.example", { example: preview.dateExample })}
									</span>
								</div>
							</div>
						</SearchableSetting>

						<SearchableSetting
							settingId="language-relative-times"
							section="language"
							label={t("settings:language.relativeTimes.label")}>
							<VSCodeCheckbox
								checked={showRelativeTimes}
								onChange={(e: Event | FormEvent<HTMLElement>) =>
									setCachedStateField("showRelativeTimes", (e.target as HTMLInputElement).checked)
								}
								data-testid="relative-times-checkbox">
								<span className="font-medium">{t("settings:language.relativeTimes.label")}</span>
							</VSCodeCheckbox>
						</SearchableSetting>

						{/* Preview card: chat message time, task history (relative or absolute), hover text */}
						<div
							className="rounded-md border border-dashed border-vscode-panel-border bg-vscode-editor-background px-3 py-2.5 text-sm flex flex-col gap-1.5"
							data-testid="time-format-preview">
							<div className="text-xs text-vscode-descriptionForeground">
								{t("settings:language.preview.title")}
							</div>
							<div data-testid="preview-chat">
								{t("settings:language.preview.chat")} · <strong>{preview.chatTime}</strong>
							</div>
							<div data-testid="preview-history">
								{t("settings:language.preview.history")} ·{" "}
								<strong>
									{showRelativeTimes ? t("settings:language.preview.relative") : preview.hover}
								</strong>
								{showRelativeTimes && (
									<span className="ml-1.5 text-xs text-vscode-descriptionForeground">
										{t("settings:language.preview.hover", { value: preview.hover })}
									</span>
								)}
							</div>
						</div>
					</div>
				</div>
			</Section>
		</div>
	)
}

const SubTitle = ({ children }: { children: React.ReactNode }) => (
	<h4 className="m-0 text-xs font-semibold uppercase tracking-wide text-vscode-descriptionForeground">{children}</h4>
)
