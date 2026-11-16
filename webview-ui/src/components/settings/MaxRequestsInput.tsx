import { useAppTranslation } from "@src/i18n/TranslationContext"

import { FormattedTextField, unlimitedIntegerFormatter } from "../common/FormattedTextField"

interface MaxRequestsInputProps {
	allowedMaxRequests?: number
	onValueChange: (value: number | undefined) => void
}

export function MaxRequestsInput({ allowedMaxRequests, onValueChange }: MaxRequestsInputProps) {
	const { t } = useAppTranslation()

	return (
		<>
			<label className="flex items-center gap-2 text-sm font-medium whitespace-nowrap">
				<span className="codicon codicon-pulse" />
				{t("settings:autoApprove.apiRequestLimit.title")}:
			</label>
			<FormattedTextField
				value={allowedMaxRequests}
				onValueChange={onValueChange}
				formatter={unlimitedIntegerFormatter}
				placeholder={t("settings:autoApprove.apiRequestLimit.unlimited")}
				style={{ maxWidth: "200px" }}
				data-testid="max-requests-input"
			/>
		</>
	)
}
