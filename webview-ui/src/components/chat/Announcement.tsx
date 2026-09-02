import { memo, type MouseEvent, type ReactNode, useState } from "react"
import { Trans } from "react-i18next"
import { SiDiscord, SiReddit, SiX } from "react-icons/si"

import { Package } from "@roo/package"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@src/components/ui"
import { EXTERNAL_LINKS } from "@src/constants/externalLinks"

interface AnnouncementProps {
	hideAnnouncement: () => void
}

/**
 * You must update the `latestAnnouncementId` in ClineProvider for new
 * announcements to show to users. This new id will be compared with what's in
 * state for the 'last announcement shown', and if it's different then the
 * announcement will render. As soon as an announcement is shown, the id will be
 * updated in state. This ensures that announcements are not shown more than
 * once, even if the user doesn't close it themselves.
 * Release-specific copy is maintained in each locale's `chat.json` announcement keys.
 */

const Announcement = ({ hideAnnouncement }: AnnouncementProps) => {
	const { t } = useAppTranslation()
	const [open, setOpen] = useState(true)

	return (
		<Dialog
			open={open}
			onOpenChange={(open) => {
				setOpen(open)

				if (!open) {
					hideAnnouncement()
				}
			}}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t("chat:announcement.title", { version: Package.version })}</DialogTitle>
				</DialogHeader>
				<div>
					<div className="mb-4">
						<p className="mb-3">{t("chat:announcement.release.heading")}</p>
						<ul className="list-disc list-inside text-sm space-y-1.5">
							<li>
								<Trans
									i18nKey="chat:announcement.release.highlight1"
									components={{ modelsLink: <ModelsLink /> }}
								/>
							</li>
							<li>{t("chat:announcement.release.highlight2")}</li>
							<li>{t("chat:announcement.release.highlight3")}</li>
						</ul>
					</div>

					<div className="mt-4 text-sm text-center text-vscode-descriptionForeground">
						<div className="flex items-center justify-center gap-4">
							<SocialLink
								icon={<SiX className="w-4 h-4" aria-hidden />}
								label="X"
								href="https://x.com/ZooCodeDev"
							/>
							<SocialLink
								icon={<SiDiscord className="w-4 h-4" aria-hidden />}
								label="Discord"
								href="https://discord.gg/VxfP4Vx3gX"
							/>
							<SocialLink
								icon={<SiReddit className="w-4 h-4" aria-hidden />}
								label="Reddit"
								href="https://www.reddit.com/r/ZooCode/"
							/>
						</div>
					</div>

					<div className="mt-3 text-sm text-center text-vscode-descriptionForeground">
						<Trans i18nKey="chat:announcement.support" components={{ githubLink: <GitHubLink /> }} />
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}

// VS Code's webview bootstrap intercepts clicks on any anchor with an href
// at the document level and opens the URL itself; it never checks
// defaultPrevented, so a click also handled here would open the URL twice.
// Stop propagation so the document-level handler never sees the click.
const openExternal = (url: string) => (event: MouseEvent<HTMLAnchorElement>) => {
	event.preventDefault()
	event.stopPropagation()
	vscode.postMessage({ type: "openExternal", url })
}

const SocialLink = ({ icon, label, href }: { icon: ReactNode; label: string; href: string }) => (
	<a
		href={href}
		className="inline-flex items-center gap-1 text-vscode-textLink-foreground"
		onClick={openExternal(href)}>
		{icon}
		<span className="sr-only">{label}</span>
	</a>
)

const GitHubLink = ({ children }: { children?: ReactNode }) => (
	<a
		href={EXTERNAL_LINKS.GITHUB_REPO}
		className="text-vscode-textLink-foreground underline"
		onClick={openExternal(EXTERNAL_LINKS.GITHUB_REPO)}>
		{children}
	</a>
)

const ModelsLink = ({ children }: { children?: ReactNode }) => (
	<a
		href={EXTERNAL_LINKS.MODELS}
		className="text-vscode-textLink-foreground underline"
		onClick={openExternal(EXTERNAL_LINKS.MODELS)}>
		{children}
	</a>
)

export default memo(Announcement)
