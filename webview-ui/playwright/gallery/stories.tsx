import React, { useState } from "react"

type StoryProps = Record<string, unknown>
type Story = (props: StoryProps) => React.ReactNode | Promise<React.ReactNode>

const mermaidGantt = `gantt
    title Project plan
    dateFormat YYYY-MM-DD
    section Planning
    Define scope :done, scope, 2026-08-01, 3d
    section Delivery
    Ship release :active, release, after scope, 3d`

export const stories: Record<string, Story> = {
	"accessibility-contrast": async () => {
		const { AccessibilityContrastGallery } =
			await import("@/components/ui/__tests__/AccessibilityContrast.visual.fixture")
		return <AccessibilityContrastGallery />
	},
	"announcement-links": async () => {
		const [{ AppProviders }, { default: Announcement }] = await Promise.all([
			import("../AppProviders"),
			import("@/components/chat/Announcement"),
		])
		return (
			<AppProviders>
				<div className="w-[520px] p-4 bg-vscode-editor-background">
					<a id="control-link" href="#control">
						control
					</a>
					<Announcement hideAnnouncement={() => undefined} />
				</div>
			</AppProviders>
		)
	},
	"chat-text-area": async () => {
		const { ChatTextAreaStory } = await import("@/components/chat/__tests__/ChatTextArea.visual.fixture")
		return <ChatTextAreaStory />
	},
	"history-empty": async () => {
		const [{ AppProviders }, { default: HistoryView }] = await Promise.all([
			import("../AppProviders"),
			import("@/components/history/HistoryView"),
		])
		return (
			<AppProviders initialState={{ taskHistory: [] }}>
				<div className="h-[640px] w-[480px] max-w-full bg-vscode-editor-background">
					<HistoryView onDone={() => undefined} />
				</div>
			</AppProviders>
		)
	},
	"layout-clipped-text": () => (
		<div className="w-40">
			<span data-testid="clipped-direct-text" className="block w-8 overflow-hidden whitespace-nowrap">
				Clipped direct text
			</span>
		</div>
	),
	"layout-screen-reader-only": () => (
		<div>
			<label className="sr-only">Hidden label</label>
			<div className="sr-only">
				<button>Hidden action</button>
			</div>
		</div>
	),
	"mermaid-gantt": async () => {
		const { default: MermaidBlock } = await import("@/components/common/MermaidBlock")
		return <MermaidBlock code={mermaidGantt} />
	},
	"model-info": async () => {
		const { ModelInfoViewFixture } = await import("@/components/settings/__tests__/ModelInfoView.visual.fixture")
		return <ModelInfoViewFixture />
	},
	"openai-codex": async () => {
		const { OpenAICodexFixture } =
			await import("@/components/settings/providers/__tests__/OpenAICodex.visual.fixture")
		return <OpenAICodexFixture />
	},
	"openai-compatible-azure": async () => {
		const { OpenAICompatibleAzureFixture } =
			await import("@/components/settings/providers/__tests__/OpenAICompatible.visual.fixture")
		return <OpenAICompatibleAzureFixture />
	},
	"rendered-content-contrast": async () => {
		const [{ AppProviders }, { RenderedContentContrastFixture }] = await Promise.all([
			import("../AppProviders"),
			import("@/components/common/__tests__/RenderedContentContrast.visual.fixture"),
		])
		return (
			<AppProviders>
				<RenderedContentContrastFixture />
			</AppProviders>
		)
	},
	"roo-hero": async () => {
		const { default: RooHero } = await import("@/components/welcome/RooHero")
		return <RooHero />
	},
	"telemetry-banner": async () => {
		const [{ TelemetryBannerFixture }, { visualTestI18nReady }] = await Promise.all([
			import("@/components/common/__tests__/TelemetryBanner.visual.fixture"),
			import("@/components/common/__tests__/TelemetryBanner.visual.i18n"),
		])
		await visualTestI18nReady
		return <TelemetryBannerFixture />
	},
	"theme-aware-controls": async () => {
		const [{ SelectDropdown }, { default: UpdateTodoListToolBlock }] = await Promise.all([
			import("@/components/ui/select-dropdown"),
			import("@/components/chat/UpdateTodoListToolBlock"),
		])
		type Todo = NonNullable<React.ComponentProps<typeof UpdateTodoListToolBlock>["todos"]>[number]

		function ThemeAwareControlsStory() {
			const [value, setValue] = useState("code")
			const [todos, setTodos] = useState<Todo[]>([
				{ id: "todo-1", content: "Ship the follow-up", status: "in_progress" },
			])
			return (
				<div className="flex flex-col gap-4 w-96">
					<SelectDropdown value={value} options={[{ value: "code", label: "Code" }]} onChange={setValue} />
					<UpdateTodoListToolBlock todos={todos} onChange={setTodos} />
				</div>
			)
		}

		return <ThemeAwareControlsStory />
	},
	"theme-sensitive-status": async () => {
		const [{ AppProviders }, { ThemeSensitiveStatusFixture }] = await Promise.all([
			import("../AppProviders"),
			import("@/components/chat/__tests__/ThemeSensitiveStatus.visual.fixture"),
		])
		return (
			<AppProviders>
				<ThemeSensitiveStatusFixture />
			</AppProviders>
		)
	},
	"theme-token-cleanup": async () => {
		const [{ Checkbox }, { enabledChatControlClassName }] = await Promise.all([
			import("@/components/ui/checkbox"),
			import("@/components/chat/chatControlStyles"),
		])
		return (
			<div className="flex flex-col gap-3 w-96">
				<button aria-label="Settings" className={enabledChatControlClassName}>
					Settings
				</button>
				<Checkbox aria-label="Include optional context" variant="description" checked />
			</div>
		)
	},
	"ui-settings": async () => {
		const { UISettingsStory } = await import("@/components/settings/__tests__/UISettings.visual.fixture")
		return <UISettingsStory />
	},
	"ui-settings-long-locale": async () => {
		const [{ UISettingsStory }, { default: i18next }] = await Promise.all([
			import("@/components/settings/__tests__/UISettings.visual.fixture"),
			import("@/i18n/setup"),
		])
		await i18next.changeLanguage("ru")
		return <UISettingsStory />
	},
	welcome: async () => {
		const [{ AppProviders }, { WelcomeLanding }] = await Promise.all([
			import("../AppProviders"),
			import("@/components/welcome/WelcomeLanding"),
		])
		return (
			<AppProviders initialState={{ apiConfiguration: {} }}>
				<WelcomeLanding onGetStarted={() => undefined} onImportSettings={() => undefined} />
			</AppProviders>
		)
	},
}
