import type { ReadFileParams } from "@roo-code/types"
import type { Task } from "../../task/Task"
import type { FileHandle } from "fs/promises"

export interface FileResult {
	path: string
	status: "approved" | "denied" | "blocked" | "error" | "pending" | "cancelled" | "unsupported"
	/** User decision is independent of the subsequent content-read outcome. */
	approvalStatus?: "approved" | "denied"
	content?: string
	error?: string
	notice?: string
	nativeContent?: string
	imageDataUrl?: string
	feedbackText?: string
	feedbackImages?: string[]
	longLinesTruncated?: boolean
	entry?: ReadFileParams
}

export interface ReadEntryOptions {
	textOnly?: boolean
}

export interface ReadFileContext {
	params: ReadFileParams
	task: Task
	fullPath: string
	extension: string
	binary: boolean
	options: ReadEntryOptions
	/** Present at the public reader boundary; strategies must not reopen a pathname when supplied. */
	file?: FileHandle
}

export interface ReadErrorContext {
	prefix?: string
	action?: string
}
