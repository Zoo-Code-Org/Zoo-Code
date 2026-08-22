import React from "react"
import { act, fireEvent, render, screen } from "@/utils/test-utils"

import { TranslationProvider } from "@/i18n/__mocks__/TranslationContext"
import { EXTERNAL_LINKS } from "@/constants/externalLinks"
import { vscode } from "@/utils/vscode"

import { About } from "../About"

vi.mock("@/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({
		children,
		onClick,
		disabled,
		...props
	}: React.ButtonHTMLAttributes<HTMLButtonElement> & { appearance?: string }) => (
		<button onClick={onClick} disabled={disabled} {...props}>
			{children}
		</button>
	),
	VSCodeCheckbox: ({ children, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => (
		<label>
			<input type="checkbox" {...props} />
			{children}
		</label>
	),
	VSCodeLink: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a href={href} {...props}>
			{children}
		</a>
	),
}))

vi.mock("@/i18n/TranslationContext", () => {
	const actual = vi.importActual("@/i18n/TranslationContext")
	return {
		...actual,
		useAppTranslation: () => ({
			t: (key: string, options?: Record<string, unknown>) => {
				if (!options) return key
				let result = key
				for (const [k, v] of Object.entries(options)) {
					result = result.replace(`{{${k}}}`, String(v))
				}
				return result
			},
		}),
	}
})

vi.mock("@roo/package", () => ({
	Package: {
		version: "1.0.0",
		sha: "abc12345",
	},
}))

describe("About", () => {
	const defaultProps = {
		telemetrySetting: "enabled" as const,
		setTelemetrySetting: vi.fn(),
	}

	const renderAbout = () =>
		render(
			<TranslationProvider>
				<About {...defaultProps} />
			</TranslationProvider>,
		)

	const dispatchImportProgress = async (progress: {
		status: "starting" | "copying" | "finished" | "failed"
		copiedFileCount: number
		totalFileCount: number
		importedTaskCount: number
		totalTaskCount: number
		currentTaskId?: string
		currentFileName?: string
	}) => {
		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "rooHistoryImportProgress", rooHistoryImportProgress: progress },
				}),
			)
		})
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders the About section header", () => {
		render(
			<TranslationProvider>
				<About {...defaultProps} />
			</TranslationProvider>,
		)
		expect(screen.getByText("settings:sections.about")).toBeInTheDocument()
	})

	it("displays version information", () => {
		render(
			<TranslationProvider>
				<About {...defaultProps} />
			</TranslationProvider>,
		)
		expect(screen.getByText(/Version: 1\.0\.0/)).toBeInTheDocument()
	})

	it("renders the bug report section with label and link text", () => {
		render(
			<TranslationProvider>
				<About {...defaultProps} />
			</TranslationProvider>,
		)
		expect(screen.getByText("settings:about.bugReport.label")).toBeInTheDocument()
		expect(screen.getByRole("link", { name: "settings:about.bugReport.link" })).toHaveAttribute(
			"href",
			EXTERNAL_LINKS.BUG_REPORT,
		)
	})

	it("renders the feature request section with label and link text", () => {
		render(
			<TranslationProvider>
				<About {...defaultProps} />
			</TranslationProvider>,
		)
		expect(screen.getByText("settings:about.featureRequest.label")).toBeInTheDocument()
		expect(screen.getByRole("link", { name: "settings:about.featureRequest.link" })).toHaveAttribute(
			"href",
			EXTERNAL_LINKS.FEATURE_REQUEST,
		)
	})

	it("renders the security issue section with label and link text", () => {
		render(
			<TranslationProvider>
				<About {...defaultProps} />
			</TranslationProvider>,
		)
		expect(screen.getByText("settings:about.securityIssue.label")).toBeInTheDocument()
		expect(screen.getByRole("link", { name: "settings:about.securityIssue.link" })).toHaveAttribute(
			"href",
			EXTERNAL_LINKS.SECURITY_POLICY,
		)
	})

	it("shows the telemetry checkbox as checked when the setting is explicitly enabled", () => {
		render(
			<TranslationProvider>
				<About {...defaultProps} telemetrySetting="enabled" />
			</TranslationProvider>,
		)

		expect(screen.getByRole("checkbox", { name: /telemetry/i })).toBeChecked()
	})

	it("shows the telemetry checkbox as checked when the setting is unset (disclosed opt-out default)", () => {
		render(
			<TranslationProvider>
				<About {...defaultProps} telemetrySetting="unset" />
			</TranslationProvider>,
		)

		expect(screen.getByRole("checkbox", { name: /telemetry/i })).toBeChecked()
	})

	it("does not show the telemetry checkbox as checked when the setting is disabled", () => {
		render(
			<TranslationProvider>
				<About {...defaultProps} telemetrySetting="disabled" />
			</TranslationProvider>,
		)

		expect(screen.getByRole("checkbox", { name: /telemetry/i })).not.toBeChecked()
	})

	it("renders export, import, and reset buttons", () => {
		render(
			<TranslationProvider>
				<About {...defaultProps} />
			</TranslationProvider>,
		)
		expect(screen.getByText("settings:footer.settings.export")).toBeInTheDocument()
		expect(screen.getByText("settings:footer.settings.import")).toBeInTheDocument()
		expect(screen.getByText("settings:footer.settings.reset")).toBeInTheDocument()
	})

	it("posts the Roo history import message when clicking the import button", () => {
		renderAbout()

		fireEvent.click(screen.getByRole("button", { name: "settings:about.rooHistoryImport.buttonIdle" }))

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "importRooHistory" })
	})

	it("shows Roo history import progress while the import is running", async () => {
		renderAbout()

		fireEvent.click(screen.getByRole("button", { name: "settings:about.rooHistoryImport.buttonIdle" }))

		expect(screen.getByRole("button", { name: "settings:about.rooHistoryImport.buttonImporting" })).toBeDisabled()

		await dispatchImportProgress({
			status: "copying",
			copiedFileCount: 2,
			totalFileCount: 8,
			importedTaskCount: 1,
			totalTaskCount: 3,
		})

		expect(screen.getByText("settings:about.rooHistoryImport.statusImporting")).toBeInTheDocument()
		expect(screen.getByText("25%")).toBeInTheDocument()
		expect(
			screen.getByRole("progressbar", { name: "settings:about.rooHistoryImport.progressAriaLabel" }),
		).toHaveAttribute("aria-valuenow", "25")
		expect(screen.getByText("settings:about.rooHistoryImport.summaryCopied")).toBeInTheDocument()
		expect(screen.getByText("settings:about.rooHistoryImport.detailTasksImported")).toBeInTheDocument()
	})

	it("keeps a failed Roo history state visible and re-enables retry after failure", async () => {
		renderAbout()

		fireEvent.click(screen.getByRole("button", { name: "settings:about.rooHistoryImport.buttonIdle" }))

		await dispatchImportProgress({
			status: "failed",
			copiedFileCount: 1,
			totalFileCount: 4,
			importedTaskCount: 0,
			totalTaskCount: 2,
		})

		expect(screen.getByText("settings:about.rooHistoryImport.statusFailed")).toBeInTheDocument()
		expect(screen.getByText("25%")).toBeInTheDocument()
		expect(screen.getByText("settings:about.rooHistoryImport.summaryFailedWithFiles")).toBeInTheDocument()
		expect(screen.getByText("settings:about.rooHistoryImport.detailFailed")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "settings:about.rooHistoryImport.buttonIdle" })).toBeEnabled()
	})

	it("keeps a completed Roo history progress summary after the import finishes", async () => {
		renderAbout()

		await dispatchImportProgress({
			status: "finished",
			copiedFileCount: 4,
			totalFileCount: 4,
			importedTaskCount: 1,
			totalTaskCount: 1,
		})

		expect(screen.getByText("settings:about.rooHistoryImport.statusComplete")).toBeInTheDocument()
		expect(screen.getByText("100%")).toBeInTheDocument()
		expect(screen.getByText("settings:about.rooHistoryImport.summaryCopied")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "settings:about.rooHistoryImport.buttonIdle" })).toBeEnabled()
	})

	it("clears stale failure UI when a new import starts and only shows the latest success state", async () => {
		renderAbout()

		fireEvent.click(screen.getByRole("button", { name: "settings:about.rooHistoryImport.buttonIdle" }))

		await dispatchImportProgress({
			status: "failed",
			copiedFileCount: 1,
			totalFileCount: 4,
			importedTaskCount: 0,
			totalTaskCount: 2,
		})

		expect(screen.getByText("settings:about.rooHistoryImport.statusFailed")).toBeInTheDocument()
		expect(screen.getByText("settings:about.rooHistoryImport.detailFailed")).toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: "settings:about.rooHistoryImport.buttonIdle" }))

		expect(screen.getByRole("button", { name: "settings:about.rooHistoryImport.buttonImporting" })).toBeDisabled()
		expect(screen.getByText("settings:about.rooHistoryImport.statusImporting")).toBeInTheDocument()
		expect(screen.queryByText("settings:about.rooHistoryImport.statusFailed")).not.toBeInTheDocument()
		expect(screen.queryByText("settings:about.rooHistoryImport.detailFailed")).not.toBeInTheDocument()

		await dispatchImportProgress({
			status: "finished",
			copiedFileCount: 3,
			totalFileCount: 3,
			importedTaskCount: 2,
			totalTaskCount: 2,
		})

		expect(screen.getByText("settings:about.rooHistoryImport.statusComplete")).toBeInTheDocument()
		expect(screen.getByText("100%")).toBeInTheDocument()
		expect(screen.getByText("settings:about.rooHistoryImport.summaryCopied")).toBeInTheDocument()
		expect(screen.getByText("settings:about.rooHistoryImport.detailTasksImported")).toBeInTheDocument()
		expect(screen.queryByText("settings:about.rooHistoryImport.statusFailed")).not.toBeInTheDocument()
		expect(screen.queryByText("settings:about.rooHistoryImport.detailFailed")).not.toBeInTheDocument()
	})
})
