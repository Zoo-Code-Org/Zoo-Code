import React from "react"
import i18next from "i18next"
import { I18nextProvider, initReactI18next } from "react-i18next"

import { TranslationContext } from "@src/i18n/TranslationContext"
import TelemetryBanner from "../TelemetryBanner"

const translations: Record<string, string> = {
	"welcome:telemetry.helpImprove": "Help Improve Zoo Code",
	"welcome:telemetry.helpImproveMessage":
		"Zoo Code collects error and usage data, linked to a per-install identifier, to help us fix bugs and improve the extension. This telemetry does not collect your code or prompts. You can turn this off in <settingsLink>settings</settingsLink>.",
	"welcome:telemetry.accept": "Accept",
	"welcome:telemetry.decline": "Decline",
}

// Trans reads from its own react-i18next instance rather than the useAppTranslation
// context, so it needs a real (if minimal) i18next init to resolve helpImproveMessage
// and the settingsLink interpolation instead of rendering nothing.
const visualTestI18n = i18next.createInstance()
void visualTestI18n.use(initReactI18next).init({
	lng: "en",
	fallbackLng: "en",
	ns: ["welcome"],
	defaultNS: "welcome",
	resources: {
		en: {
			welcome: {
				telemetry: {
					helpImprove: translations["welcome:telemetry.helpImprove"],
					helpImproveMessage: translations["welcome:telemetry.helpImproveMessage"],
					accept: translations["welcome:telemetry.accept"],
					decline: translations["welcome:telemetry.decline"],
				},
			},
		},
	},
	interpolation: { escapeValue: false },
})

export const TelemetryBannerFixture = () => (
	<I18nextProvider i18n={visualTestI18n}>
		<TranslationContext.Provider
			value={{
				t: (key) => translations[key] ?? key,
				i18n: null as unknown as typeof import("../../../i18n/setup").default,
			}}>
			<TelemetryBanner />
		</TranslationContext.Provider>
	</I18nextProvider>
)
