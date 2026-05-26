import { fireEvent, render, screen } from "@testing-library/react"
import { vi } from "vitest"

import CommitMessagePromptSettings from "../CommitMessagePromptSettings"

const mockPostMessage = vi.fn()
;(global as any).acquireVsCodeApi = () => ({ postMessage: mockPostMessage })

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, values?: Record<string, unknown>) =>
			values?.count !== undefined ? `${key} ${values.count}` : key,
	}),
}))

vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick, disabled, "data-testid": dataTestId }: any) => (
		<button onClick={onClick} disabled={disabled} data-testid={dataTestId}>
			{children}
		</button>
	),
	Select: ({ children, value, onValueChange }: any) => (
		<div data-testid="select" data-value={value}>
			<button data-testid="select-change-release" onClick={() => onValueChange?.("release")}>
				change release
			</button>
			{children}
		</div>
	),
	SelectContent: ({ children }: any) => <div>{children}</div>,
	SelectItem: ({ children, value, "data-testid": dataTestId }: any) => (
		<div data-testid={dataTestId} data-value={value}>
			{children}
		</div>
	),
	SelectTrigger: ({ children, "data-testid": dataTestId }: any) => <div data-testid={dataTestId}>{children}</div>,
	SelectValue: ({ placeholder }: any) => <div>{placeholder}</div>,
	StandardTooltip: ({ children }: any) => <>{children}</>,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children, checked, onChange, "data-testid": dataTestId }: any) => (
		<label>
			<input type="checkbox" checked={checked} onChange={(event) => onChange(event)} data-testid={dataTestId} />
			{children}
		</label>
	),
	VSCodeTextArea: ({ value, onInput, "data-testid": dataTestId }: any) => (
		<textarea value={value} onChange={(event) => onInput(event)} data-testid={dataTestId} />
	),
	VSCodeTextField: ({ children, value, onInput, "data-testid": dataTestId }: any) => (
		<label>
			{children}
			<input value={value} onChange={(event) => onInput(event)} data-testid={dataTestId} />
		</label>
	),
}))

describe("CommitMessagePromptSettings", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("updates single-profile prompt fallback without creating stored profiles", () => {
		const setCommitMessageProfiles = vi.fn()
		const setCustomSupportPrompts = vi.fn()
		const setCommitMessageApiConfigId = vi.fn()
		const setCommitMessageGitContext = vi.fn()
		const setCommitMessageAttribution = vi.fn()

		render(
			<CommitMessagePromptSettings
				listApiConfigMeta={[]}
				customSupportPrompts={{ COMMIT_MESSAGE: "Legacy prompt ${gitContext}" }}
				setCustomSupportPrompts={setCustomSupportPrompts}
				commitMessageApiConfigId="legacy-api"
				setCommitMessageApiConfigId={setCommitMessageApiConfigId}
				commitMessageGitContext={{ diffContextLines: 4 }}
				setCommitMessageGitContext={setCommitMessageGitContext}
				commitMessageAttribution={{ enabled: false }}
				setCommitMessageAttribution={setCommitMessageAttribution}
				commitMessageProfiles={undefined}
				setCommitMessageProfiles={setCommitMessageProfiles}
			/>,
		)

		fireEvent.change(screen.getByTestId("commit-message-prompt-textarea"), {
			target: { value: "Profile prompt ${gitContext}" },
		})

		expect(setCommitMessageProfiles).not.toHaveBeenCalled()
		expect(setCommitMessageApiConfigId).not.toHaveBeenCalled()
		expect(setCommitMessageGitContext).not.toHaveBeenCalled()
		expect(setCustomSupportPrompts).toHaveBeenCalledWith({ COMMIT_MESSAGE: "Profile prompt ${gitContext}" })
		expect(mockPostMessage).not.toHaveBeenCalled()
	})

	it("updates top-level attribution when stored profiles do not exist", () => {
		const setCommitMessageProfiles = vi.fn()
		const setCommitMessageAttribution = vi.fn()

		render(
			<CommitMessagePromptSettings
				listApiConfigMeta={[]}
				customSupportPrompts={{}}
				setCustomSupportPrompts={vi.fn()}
				commitMessageApiConfigId=""
				setCommitMessageApiConfigId={vi.fn()}
				commitMessageGitContext={{ diffContextLines: 4 }}
				setCommitMessageGitContext={vi.fn()}
				commitMessageAttribution={{ enabled: false, template: "Assisted-by: ${providerModel}" }}
				setCommitMessageAttribution={setCommitMessageAttribution}
				commitMessageProfiles={undefined}
				setCommitMessageProfiles={setCommitMessageProfiles}
			/>,
		)

		fireEvent.click(screen.getByTestId("commit-message-attribution-enabled"))

		expect(setCommitMessageAttribution).toHaveBeenCalledWith({
			enabled: true,
			template: "Assisted-by: ${providerModel}",
		})
		expect(setCommitMessageProfiles).not.toHaveBeenCalled()
	})

	it("updates only the active stored profile attribution", () => {
		const setCommitMessageProfiles = vi.fn()
		const setCommitMessageAttribution = vi.fn()

		render(
			<CommitMessagePromptSettings
				listApiConfigMeta={[]}
				customSupportPrompts={{}}
				setCustomSupportPrompts={vi.fn()}
				commitMessageApiConfigId=""
				setCommitMessageApiConfigId={vi.fn()}
				commitMessageGitContext={{ diffContextLines: 4 }}
				setCommitMessageGitContext={vi.fn()}
				commitMessageAttribution={{ enabled: true, template: "Top-level ${providerModel}" }}
				setCommitMessageAttribution={setCommitMessageAttribution}
				commitMessageProfiles={{
					activeProfileId: "release",
					profiles: [
						{ id: "default", name: "Default", attribution: { enabled: true, template: "Default" } },
						{ id: "release", name: "Release", attribution: { enabled: false, template: "Release" } },
					],
				}}
				setCommitMessageProfiles={setCommitMessageProfiles}
			/>,
		)

		fireEvent.click(screen.getByTestId("commit-message-attribution-enabled"))

		expect(setCommitMessageProfiles).toHaveBeenCalledWith({
			activeProfileId: "release",
			profiles: [
				{ id: "default", name: "Default", attribution: { enabled: true, template: "Default" } },
				{ id: "release", name: "Release", attribution: { enabled: true, template: "Release" } },
			],
		})
		expect(setCommitMessageAttribution).not.toHaveBeenCalled()
	})

	it("profile switch only updates active profile id and preserves profile-local options", () => {
		const setCommitMessageProfiles = vi.fn()
		const setCommitMessageAttribution = vi.fn()
		const setCommitMessageApiConfigId = vi.fn()
		const setCommitMessageGitContext = vi.fn()
		const setCustomSupportPrompts = vi.fn()

		render(
			<CommitMessagePromptSettings
				listApiConfigMeta={[]}
				customSupportPrompts={{}}
				setCustomSupportPrompts={setCustomSupportPrompts}
				commitMessageApiConfigId=""
				setCommitMessageApiConfigId={setCommitMessageApiConfigId}
				commitMessageGitContext={{ diffContextLines: 4 }}
				setCommitMessageGitContext={setCommitMessageGitContext}
				commitMessageAttribution={{ enabled: true, template: "Top-level ${providerModel}" }}
				setCommitMessageAttribution={setCommitMessageAttribution}
				commitMessageProfiles={{
					activeProfileId: "default",
					profiles: [
						{
							id: "default",
							name: "Default",
							gitContext: { includeRecentCommitBodies: true, includeRecentCommitStats: true },
							attribution: { enabled: true, template: "Default" },
						},
						{
							id: "release",
							name: "Release",
							gitContext: { includeRecentCommitBodies: false, includeRecentCommitStats: false },
							attribution: { enabled: false, template: "Release" },
						},
					],
				}}
				setCommitMessageProfiles={setCommitMessageProfiles}
			/>,
		)

		fireEvent.click(screen.getAllByTestId("select-change-release")[0])

		expect(setCommitMessageProfiles).toHaveBeenCalledWith({
			activeProfileId: "release",
			profiles: [
				{
					id: "default",
					name: "Default",
					gitContext: { includeRecentCommitBodies: true, includeRecentCommitStats: true },
					attribution: { enabled: true, template: "Default" },
				},
				{
					id: "release",
					name: "Release",
					gitContext: { includeRecentCommitBodies: false, includeRecentCommitStats: false },
					attribution: { enabled: false, template: "Release" },
				},
			],
		})
		expect(setCommitMessageAttribution).not.toHaveBeenCalled()
		expect(setCommitMessageApiConfigId).not.toHaveBeenCalled()
		expect(setCommitMessageGitContext).not.toHaveBeenCalled()
		expect(setCustomSupportPrompts).not.toHaveBeenCalled()
	})

	it("updates only the active stored profile git context option", () => {
		const setCommitMessageProfiles = vi.fn()

		render(
			<CommitMessagePromptSettings
				listApiConfigMeta={[]}
				customSupportPrompts={{}}
				setCustomSupportPrompts={vi.fn()}
				commitMessageApiConfigId=""
				setCommitMessageApiConfigId={vi.fn()}
				commitMessageGitContext={{ diffContextLines: 4 }}
				setCommitMessageGitContext={vi.fn()}
				commitMessageAttribution={{ enabled: true, template: "Top-level ${providerModel}" }}
				setCommitMessageAttribution={vi.fn()}
				commitMessageProfiles={{
					activeProfileId: "release",
					profiles: [
						{ id: "default", name: "Default", gitContext: { includeRecentCommitBodies: true } },
						{ id: "release", name: "Release", gitContext: { includeRecentCommitBodies: false } },
					],
				}}
				setCommitMessageProfiles={setCommitMessageProfiles}
			/>,
		)

		fireEvent.click(
			screen.getByRole("checkbox", {
				name: /supportPrompts\.commitMessage\.gitContext\.includeRecentCommitBodies/i,
			}),
		)

		expect(setCommitMessageProfiles).toHaveBeenCalledWith({
			activeProfileId: "release",
			profiles: [
				{ id: "default", name: "Default", gitContext: { includeRecentCommitBodies: true } },
				{ id: "release", name: "Release", gitContext: { includeRecentCommitBodies: true } },
			],
		})
	})
})
