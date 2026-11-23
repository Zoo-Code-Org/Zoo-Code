import type { McpResource, McpResourceTemplate } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"

type McpResourceRowProps = {
	item: McpResource | McpResourceTemplate
}

const McpResourceRow = ({ item }: McpResourceRowProps) => {
	const { t } = useAppTranslation()
	const hasUri = "uri" in item
	const uri = hasUri ? item.uri : item.uriTemplate

	return (
		<div
			key={uri}
			style={{
				padding: "3px 0",
			}}>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					marginBottom: "4px",
				}}>
				<span className={`codicon codicon-symbol-file`} style={{ marginRight: "6px" }} />
				<span style={{ fontWeight: 500, wordBreak: "break-all" }}>{uri}</span>
			</div>
			<div
				style={{
					fontSize: "12px",
					opacity: 0.8,
					margin: "4px 0",
				}}>
				{item.name && item.description
					? `${item.name}: ${item.description}`
					: !item.name && item.description
						? item.description
						: !item.description && item.name
							? item.name
							: t("mcp:tool.noDescription")}
			</div>
			<div
				style={{
					fontSize: "12px",
				}}>
				<span style={{ opacity: 0.8 }}>{t("mcp:resource.returns")} </span>
				<code
					style={{
						color: "var(--vscode-textPreformat-foreground)",
						background: "var(--vscode-textPreformat-background)",
						padding: "1px 4px",
						borderRadius: "3px",
					}}>
					{item.mimeType || t("mcp:resource.unknownMimeType")}
				</code>
			</div>
		</div>
	)
}

export default McpResourceRow
