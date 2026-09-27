import { Trans } from "react-i18next"

import { Button } from "@src/components/ui"
import { useAppTranslation } from "@src/i18n/TranslationContext"

import { Tab, TabContent } from "../common/Tab"
import RooHero from "./RooHero"

interface WelcomeLandingProps {
	onGetStarted: () => void
	onImportSettings: () => void
}

export function WelcomeLanding({ onGetStarted, onImportSettings }: WelcomeLandingProps) {
	const { t } = useAppTranslation()

	return (
		<Tab>
			<TabContent className="relative flex flex-col gap-4 p-6 justify-center">
				<RooHero />
				<h2 className="mt-0 mb-0 text-xl">{t("welcome:landing.greeting")}</h2>

				<div className="space-y-4 leading-normal">
					<p className="text-base text-vscode-foreground">
						<Trans i18nKey="welcome:landing.introduction" />
					</p>
				</div>

				<div className="mt-2 flex gap-2 items-center">
					<Button onClick={onGetStarted} variant="primary">
						{t("welcome:providerSignup.heading")}
					</Button>
				</div>

				<div className="absolute bottom-6 left-6">
					<button
						onClick={onImportSettings}
						className="cursor-pointer bg-transparent border-none p-0 text-vscode-foreground hover:underline">
						{t("welcome:importSettings")}
					</button>
				</div>
			</TabContent>
		</Tab>
	)
}
