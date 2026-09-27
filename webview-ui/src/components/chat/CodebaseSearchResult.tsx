import React from "react"
import { useTranslation } from "react-i18next"
import { vscode } from "@src/utils/vscode"
import { StandardTooltip } from "@/components/ui"

interface CodebaseSearchResultProps {
	filePath: string
	score: number
	startLine: number
	endLine: number
	snippet: string
	language: string
}

const CodebaseSearchResult: React.FC<CodebaseSearchResultProps> = ({ filePath, score, startLine, endLine }) => {
	const { t } = useTranslation("chat")

	const handleClick = () => {
		console.log(filePath)
		vscode.postMessage({
			type: "openFile",
			text: "./" + filePath,
			values: {
				line: startLine,
			},
		})
	}

	return (
		<StandardTooltip content={t("codebaseSearch.resultTooltip", { score: score.toFixed(3) })}>
			<div
				onClick={handleClick}
				className="group p-2 border border-vscode-editorGroup-border cursor-pointer hover:bg-vscode-list-hoverBackground">
				<div className="flex gap-2 items-center overflow-hidden">
					<span className="text-vscode-textLink-foreground group-hover:text-vscode-list-hoverForeground whitespace-nowrap flex-shrink-0">
						{filePath.split("/").at(-1)}:{startLine === endLine ? startLine : `${startLine}-${endLine}`}
					</span>
					<span className="text-vscode-descriptionForeground group-hover:text-vscode-list-hoverForeground truncate min-w-0 flex-1">
						{filePath.split("/").slice(0, -1).join("/")}
					</span>
					<span className="text-xs text-vscode-descriptionForeground group-hover:text-vscode-list-hoverForeground whitespace-nowrap ml-auto opacity-60">
						{score.toFixed(3)}
					</span>
				</div>
			</div>
		</StandardTooltip>
	)
}

export default CodebaseSearchResult
