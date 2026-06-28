import { DEFAULT_TOOL_REPETITION_SOFT_LIMIT } from "@roo-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"

import { Slider } from "@/components/ui"

interface ToolRepetitionLimitControlProps {
	softValue: number
	onSoftChange: (value: number) => void
}

export const ToolRepetitionLimitControl = ({
	softValue,
	onSoftChange,
}: ToolRepetitionLimitControlProps) => {
	const { t } = useAppTranslation()

	const resolvedSoft = softValue ?? DEFAULT_TOOL_REPETITION_SOFT_LIMIT

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col gap-1">
				<label className="block font-medium mb-1">
					{t("settings:providers.toolRepetitionSoftLimit.label")}
				</label>
				<div className="flex items-center gap-2">
					<Slider
						value={[resolvedSoft]}
						min={0}
						max={10}
						step={1}
						onValueChange={(newValue) => onSoftChange(Math.max(0, newValue[0]))}
					/>
					<span className="w-10">{Math.max(0, resolvedSoft)}</span>
				</div>
				<div className="text-sm text-vscode-descriptionForeground">
					{t("settings:providers.toolRepetitionSoftLimit.description")}
				</div>
			</div>
		</div>
	)
}
