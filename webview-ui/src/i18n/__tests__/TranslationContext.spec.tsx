import { render, act } from "@/utils/test-utils"
import React from "react"

import TranslationProvider, { useAppTranslation } from "../TranslationContext"

// Hoisted mock definitions — must be defined before vi.mock calls
// because vi.mock is hoisted to the top of the file.
const mockTranslations = vi.hoisted((): Record<string, Record<string, string>> => ({
	en: {
		"settings.autoApprove.title": "Auto-Approve",
		"notifications.error": "Operation failed",
		"common:confirmation.editMessage": "Edit Message",
		"common:confirmation.deleteMessage": "Delete Message",
		"common:confirmation.editWarning":
			"Editing this message will delete all subsequent messages in the conversation. Do you want to proceed?",
		"common:confirmation.deleteWarning":
			"Deleting this message will delete all subsequent messages in the conversation. Do you want to proceed?",
		"common:answers.cancel": "Cancel",
		"common:confirmation.proceed": "Proceed",
	},
	ru: {
		"settings.autoApprove.title": "Авто-Одобрение",
		"notifications.error": "Ошибка операции",
		"common:confirmation.editMessage": "Редактировать Сообщение",
		"common:confirmation.deleteMessage": "Удалить Сообщение",
		"common:confirmation.editWarning":
			"Редактирование этого сообщения приведет к удалению всех последующих сообщений в разговоре. Хотите продолжить?",
		"common:confirmation.deleteWarning":
			"Удаление этого сообщения приведет к удалению всех последующих сообщений в разговоре. Хотите продолжить?",
		"common:answers.cancel": "Отмена",
		"common:confirmation.proceed": "Продолжить",
	},
}))

const mockLanguageState = vi.hoisted(() => ({
	current: "en" as string,
	reset() {
		this.current = "en"
	},
}))

const mockI18n = vi.hoisted(() => ({
	t: (key: string, options?: Record<string, any>) => {
		const langTranslations = mockTranslations[mockLanguageState.current] || mockTranslations.en
		let result = langTranslations[key] || key
		if (options?.message) {
			result = result.replace("{{message}}", options.message)
		}
		return result
	},
	get language() {
		return mockLanguageState.current
	},
	changeLanguage: vi.fn((lang: string) => {
		mockLanguageState.current = lang
	}),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		language: mockI18n.language,
	}),
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ i18n: mockI18n }),
}))

vi.mock("../setup", () => ({
	default: mockI18n,
	loadTranslations: vi.fn(),
}))

const TestComponent = () => {
	const { t } = useAppTranslation()
	return (
		<div>
			<h1 data-testid="translation-test">{t("settings.autoApprove.title")}</h1>
			<p data-testid="translation-interpolation">
				{t("notifications.error", { message: "Test error" })}
			</p>
		</div>
	)
}

describe("TranslationContext", () => {
	beforeEach(() => {
		mockLanguageState.reset()
	})

	it("should provide translations via context", () => {
		const { getByTestId } = render(
			<TranslationProvider>
				<TestComponent />
			</TranslationProvider>,
		)

		expect(getByTestId("translation-test")).toHaveTextContent("Auto-Approve")
	})

	it("should handle interpolation correctly", () => {
		const { getByTestId } = render(
			<TranslationProvider>
				<TestComponent />
			</TranslationProvider>,
		)

		expect(getByTestId("translation-interpolation")).toHaveTextContent("Operation failed")
	})

	it("should re-render consumers when language changes (regression for memoized components)", () => {
		const MemoizedConsumer = React.memo(() => {
			const { t } = useAppTranslation()
			return (
				<div>
					<span data-testid="memo-title">{t("common:confirmation.editMessage")}</span>
					<span data-testid="memo-desc">{t("common:confirmation.editWarning")}</span>
					<span data-testid="memo-cancel">{t("common:answers.cancel")}</span>
					<span data-testid="memo-proceed">{t("common:confirmation.proceed")}</span>
				</div>
			)
		})

		const NormalConsumer = () => {
			const { t } = useAppTranslation()
			return (
				<div>
					<span data-testid="normal-title">{t("common:confirmation.editMessage")}</span>
					<span data-testid="normal-desc">{t("common:confirmation.editWarning")}</span>
				</div>
			)
		}

		const { getByTestId, rerender } = render(
			<TranslationProvider>
				<MemoizedConsumer />
				<NormalConsumer />
			</TranslationProvider>,
		)

		// Initial render — English
		expect(getByTestId("memo-title")).toHaveTextContent("Edit Message")
		expect(getByTestId("memo-desc")).toHaveTextContent(
			"Editing this message will delete all subsequent messages",
		)
		expect(getByTestId("memo-cancel")).toHaveTextContent("Cancel")
		expect(getByTestId("memo-proceed")).toHaveTextContent("Proceed")
		expect(getByTestId("normal-title")).toHaveTextContent("Edit Message")

		// Change language to Russian
		act(() => {
			mockI18n.changeLanguage("ru")
		})

		// Re-render to pick up context change
		rerender(
			<TranslationProvider>
				<MemoizedConsumer />
				<NormalConsumer />
			</TranslationProvider>,
		)

		// Both memoized and normal consumers should show Russian
		expect(getByTestId("memo-title")).toHaveTextContent("Редактировать Сообщение")
		expect(getByTestId("memo-desc")).toHaveTextContent(
			"Редактирование этого сообщения приведет к удалению",
		)
		expect(getByTestId("memo-cancel")).toHaveTextContent("Отмена")
		expect(getByTestId("memo-proceed")).toHaveTextContent("Продолжить")
		expect(getByTestId("normal-title")).toHaveTextContent("Редактировать Сообщение")
	})

	it("should re-render delete dialog with correct translations after language switch", () => {
		const DeleteDialog = React.memo(() => {
			const { t } = useAppTranslation()
			return (
				<div>
					<span data-testid="delete-title">{t("common:confirmation.deleteMessage")}</span>
					<span data-testid="delete-desc">{t("common:confirmation.deleteWarning")}</span>
				</div>
			)
		})

		const { getByTestId, rerender } = render(
			<TranslationProvider>
				<DeleteDialog />
			</TranslationProvider>,
		)

		expect(getByTestId("delete-title")).toHaveTextContent("Delete Message")
		expect(getByTestId("delete-desc")).toHaveTextContent(
			"Deleting this message will delete all subsequent messages",
		)

		act(() => {
			mockI18n.changeLanguage("ru")
		})

		rerender(
			<TranslationProvider>
				<DeleteDialog />
			</TranslationProvider>,
		)

		expect(getByTestId("delete-title")).toHaveTextContent("Удалить Сообщение")
		expect(getByTestId("delete-desc")).toHaveTextContent(
			"Удаление этого сообщения приведет к удалению",
		)
	})
})
