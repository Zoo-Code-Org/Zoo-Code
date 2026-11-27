import { useState } from "react"
import { useDynamicToolStatus } from "@src/hooks/useDynamicToolStatus"
import { useAppTranslation } from "@src/i18n/TranslationContext"

export const DynamicToolsStatus = () => {
	const { t } = useAppTranslation()
	const { mode, attachedToolNames, attachedCount, totalScoped } = useDynamicToolStatus()
	const [isExpanded, setIsExpanded] = useState(false)

	if (mode === "all") return null

	return (
		<div className="px-3 py-1 text-xs text-vscode-descriptionForeground">
			<button
				type="button"
				className="flex items-center gap-1 p-0 bg-transparent border-none text-inherit cursor-pointer"
				aria-expanded={isExpanded}
				onClick={() => setIsExpanded((expanded) => !expanded)}>
				<span className={`codicon codicon-chevron-${isExpanded ? "down" : "right"}`} aria-hidden="true" />
				{t("chat:dynamicToolsStatus.summary", { attached: attachedCount, total: totalScoped })}
			</button>
			{isExpanded && (
				<ul className="max-h-40 overflow-y-auto my-1 pl-6 break-all">
					{attachedToolNames.map((name) => (
						<li key={name}>{name}</li>
					))}
				</ul>
			)}
		</div>
	)
}
