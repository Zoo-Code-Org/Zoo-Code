import React, { useCallback, useEffect, useState } from "react"

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Button,
	Input,
} from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { cn } from "@/lib/utils"

export interface FolderNameDialogProps {
	/** Whether the dialog is open. */
	open: boolean
	/** Callback when the dialog open state changes. */
	onOpenChange: (open: boolean) => void
	/** Callback when a valid name is confirmed. */
	onConfirm: (name: string) => void
	/** Optional default name. */
	defaultName?: string
}

const MAX_NAME_LENGTH = 80

function validateFolderName(name: string): { valid: boolean; error?: string } {
	const normalized = name.trim().normalize("NFC")
	if (normalized.length === 0) {
		return { valid: false, error: "history:folderNameRequired" }
	}
	if (normalized.length > MAX_NAME_LENGTH) {
		return { valid: false, error: "history:folderNameTooLong" }
	}
	if (/[\p{C}]/u.test(normalized)) {
		return { valid: false, error: "history:folderNameInvalidChars" }
	}
	return { valid: true }
}

/**
 * Dialog for entering a new manual folder name after a task-on-task drop.
 * Validates NFC-normalized names, trims whitespace, and rejects control
 * characters.
 */
export const FolderNameDialog: React.FC<FolderNameDialogProps> = ({
	open,
	onOpenChange,
	onConfirm,
	defaultName = "",
}) => {
	const { t } = useAppTranslation()
	const [value, setValue] = useState(defaultName)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		if (open) {
			setValue(defaultName)
			setError(null)
		}
	}, [open, defaultName])

	const handleChange = useCallback((next: string) => {
		setValue(next)
		setError(null)
	}, [])

	const handleConfirm = useCallback(() => {
		const result = validateFolderName(value)
		if (!result.valid) {
			setError(result.error ?? null)
			return
		}
		onConfirm(value.trim().normalize("NFC"))
		onOpenChange(false)
	}, [value, onConfirm, onOpenChange])

	const handleCancel = useCallback(() => {
		onOpenChange(false)
	}, [onOpenChange])

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key === "Enter") {
				e.preventDefault()
				handleConfirm()
			} else if (e.key === "Escape") {
				e.preventDefault()
				handleCancel()
			}
		},
		[handleConfirm, handleCancel],
	)

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md" onEscapeKeyDown={handleCancel}>
				<DialogHeader>
					<DialogTitle>{t("history:newFolder")}</DialogTitle>
					<DialogDescription>{t("history:createFolderDescription")}</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-2">
					<Input
						autoFocus
						value={value}
						onChange={(e) => handleChange(e.target.value)}
						onKeyDown={handleKeyDown}
						maxLength={MAX_NAME_LENGTH + 1}
						placeholder={t("history:folderNamePlaceholder")}
						aria-label={t("history:folderNameLabel")}
						data-testid="folder-name-input"
						className={cn(error && "border-vscode-errorForeground")}
					/>
					{error && (
						<span className="text-xs text-vscode-errorForeground" data-testid="folder-name-error">
							{t(error)}
						</span>
					)}
				</div>

				<DialogFooter>
					<Button variant="secondary" onClick={handleCancel} data-testid="folder-name-cancel">
						{t("history:cancel")}
					</Button>
					<Button onClick={handleConfirm} data-testid="folder-name-confirm">
						{t("history:newFolder")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
