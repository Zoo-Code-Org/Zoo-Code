import { memo, useEffect, useMemo, useState, useCallback, useRef } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, ChevronRight, FileDiff } from "lucide-react"
import { createTwoFilesPatch } from "diff"

import type { ClineMessage, ExtensionMessage } from "@roo-code/types"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui"
import { cn } from "@/lib/utils"
import { vscode } from "@src/utils/vscode"

import { fileChangesFromMessages, type FileChangeEntry } from "./utils/fileChangesFromMessages"
import CodeAccordion from "../common/CodeAccordion"

interface FileChangesPanelProps {
	clineMessages: ClineMessage[] | undefined
	taskId?: string
	className?: string
}

// `ts` is not unique, so the message's own id identifies it; `ts` only covers messages persisted without one.
const originalKey = (entry: { messageId?: string; ts: number }) => entry.messageId ?? `ts:${entry.ts}`

const FileChangesPanel = memo(({ clineMessages, taskId, className }: FileChangesPanelProps) => {
	const { t } = useTranslation()
	const [panelExpanded, setPanelExpanded] = useState(false)
	const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
	const [finalContentByPath, setFinalContentByPath] = useState<Record<string, string | null>>({})
	const pendingPathsRef = useRef<Set<string>>(new Set())
	// The extension omits `originalContent` from the messages it posts; it is requested when a row is expanded.
	const [originalContentByKey, setOriginalContentByKey] = useState<Record<string, string | null>>({})
	// In-flight requests, keyed by task and message. Deliberately not reset with the caches below: a request cannot
	// be cancelled, so a reset would let a task switch (A -> B -> A) send a duplicate while the first is still open.
	const pendingOriginalRequestsRef = useRef<Set<string>>(new Set())

	// Reset expanded file rows and final content cache when switching to a different task
	useEffect(() => {
		setExpandedPaths(new Set())
		setFinalContentByPath({})
		pendingPathsRef.current = new Set()
		setOriginalContentByKey({})
	}, [clineMessages, taskId])

	const fileChanges = useMemo(() => fileChangesFromMessages(clineMessages), [clineMessages])

	// Group by path so we show one row per file (multiple edits to same file combined for display)
	const byPath = useMemo(() => {
		const map = new Map<string, FileChangeEntry[]>()
		for (const entry of fileChanges) {
			const key = entry.path
			const list = map.get(key) ?? []
			list.push(entry)
			map.set(key, list)
		}
		return map
	}, [fileChanges])

	// Aggregate total lines added/removed across all files for the panel header
	const totalStats = useMemo(() => {
		return fileChanges.reduce(
			(acc, e) => ({
				added: acc.added + (e.diffStats?.added ?? 0),
				removed: acc.removed + (e.diffStats?.removed ?? 0),
			}),
			{ added: 0, removed: 0 },
		)
	}, [fileChanges])

	const togglePath = useCallback((path: string) => {
		setExpandedPaths((prev) => {
			const next = new Set(prev)
			if (next.has(path)) next.delete(path)
			else next.add(path)
			return next
		})
	}, [])

	// Request the final file content (and the omitted original content) when a row is expanded and the edit has an original
	useEffect(() => {
		for (const path of expandedPaths) {
			const entries = byPath.get(path)
			if (!entries?.length) continue
			const first = entries[0]
			const lookupPath = path.startsWith("./") ? path.slice(2) : path
			if (
				first.hasOriginalContent &&
				!(lookupPath in finalContentByPath) &&
				!pendingPathsRef.current.has(lookupPath)
			) {
				pendingPathsRef.current.add(lookupPath)
				vscode.postMessage({ type: "readFileContent", text: lookupPath })
			}
			const requestKey = `${taskId ?? ""}|${originalKey(first)}`
			if (
				first.hasOriginalContent &&
				first.originalContent === undefined &&
				!(originalKey(first) in originalContentByKey) &&
				!pendingOriginalRequestsRef.current.has(requestKey)
			) {
				pendingOriginalRequestsRef.current.add(requestKey)
				vscode.postMessage({
					type: "readOriginalContent",
					messageTs: first.ts,
					messageId: first.messageId,
					taskId,
				})
			}
		}
	}, [expandedPaths, byPath, finalContentByPath, originalContentByKey, taskId])

	// Listen for fileContent and originalContent responses
	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const message: ExtensionMessage = event.data
			if (message.type === "fileContent" && message.fileContent?.path != null) {
				const fc = message.fileContent
				pendingPathsRef.current.delete(fc.path)
				setFinalContentByPath((prev) => ({ ...prev, [fc.path]: fc.content ?? null }))
			} else if (message.type === "originalContent" && message.originalContentInfo) {
				const { taskId: responseTaskId, content, ...id } = message.originalContentInfo
				const key = originalKey(id)
				pendingOriginalRequestsRef.current.delete(`${responseTaskId ?? ""}|${key}`)
				// A late response for another task must not populate this task's cache.
				if (responseTaskId !== taskId) return
				setOriginalContentByKey((prev) => ({ ...prev, [key]: content }))
			}
		}
		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [taskId])

	if (fileChanges.length === 0) return null

	const fileCount = byPath.size

	return (
		<Collapsible open={panelExpanded} onOpenChange={setPanelExpanded} className={cn("px-3", className)}>
			<CollapsibleTrigger
				className={cn(
					"flex items-center gap-2 w-full py-2 rounded-md text-left text-vscode-foreground",
					"hover:bg-vscode-list-hoverBackground",
				)}>
				{panelExpanded ? (
					<ChevronDown className="size-4 shrink-0" aria-hidden />
				) : (
					<ChevronRight className="size-4 shrink-0" aria-hidden />
				)}
				<FileDiff className="size-4 shrink-0" aria-hidden />
				<span className="text-sm font-medium">
					{t("chat:fileChangesInConversation.header", { count: fileCount })}
				</span>
				{totalStats.added > 0 || totalStats.removed > 0 ? (
					<div
						className="flex items-center gap-2 ml-auto shrink-0"
						aria-label={`${totalStats.added} lines added, ${totalStats.removed} lines removed`}>
						<span className="text-xs font-medium text-vscode-charts-green" data-testid="total-added">
							+{totalStats.added}
						</span>
						<span className="text-xs font-medium text-vscode-charts-red" data-testid="total-removed">
							-{totalStats.removed}
						</span>
					</div>
				) : null}
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="flex flex-col gap-1 pb-2 pl-6">
					{Array.from(byPath.entries()).map(([path, entries]) => {
						const originalContent =
							entries[0].originalContent ?? originalContentByKey[originalKey(entries[0])] ?? undefined
						const lookupPath = path.startsWith("./") ? path.slice(2) : path
						const finalContent = finalContentByPath[lookupPath]
						const hasMergedDiff =
							originalContent !== undefined && finalContent != null && finalContent !== ""
						const displayDiff = hasMergedDiff
							? createTwoFilesPatch(path, path, originalContent, finalContent)
							: entries.map((e) => e.diff).join("\n\n")
						const combinedStats = entries.reduce(
							(acc, e) => ({
								added: acc.added + (e.diffStats?.added ?? 0),
								removed: acc.removed + (e.diffStats?.removed ?? 0),
							}),
							{ added: 0, removed: 0 },
						)
						const isExpanded = expandedPaths.has(path)
						return (
							<div key={path} className="rounded border border-vscode-panel-border overflow-hidden">
								<CodeAccordion
									path={path}
									code={displayDiff}
									language="diff"
									isExpanded={isExpanded}
									onToggleExpand={() => togglePath(path)}
									diffStats={
										combinedStats.added > 0 || combinedStats.removed > 0 ? combinedStats : undefined
									}
									onJumpToFile={
										path
											? () =>
													vscode.postMessage({
														type: "openFile",
														text: path.startsWith("./") ? path : "./" + path,
													})
											: undefined
									}
								/>
							</div>
						)
					})}
				</div>
			</CollapsibleContent>
		</Collapsible>
	)
})

FileChangesPanel.displayName = "FileChangesPanel"

export default FileChangesPanel
