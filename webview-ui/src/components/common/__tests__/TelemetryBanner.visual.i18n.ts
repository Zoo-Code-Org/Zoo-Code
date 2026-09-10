import i18next from "i18next"
import { initReactI18next } from "react-i18next"

export const visualTestTranslations: Record<string, string> = {
	"welcome:telemetry.helpImprove": "Help Improve Zoo Code",
	"welcome:telemetry.helpImproveMessage":
		"Zoo Code collects error and usage data, linked to a per-install identifier, to help us fix bugs and improve the extension. This telemetry does not collect your code or prompts. You can turn this off in <settingsLink>settings</settingsLink>.",
	"welcome:telemetry.accept": "Accept",
	"welcome:telemetry.decline": "Decline",
}

// Trans reads from its own react-i18next instance rather than the useAppTranslation
// context, so it needs a real (if minimal) i18next init to resolve helpImproveMessage
// and the settingsLink interpolation instead of rendering nothing. init() returns a
// promise even for inline resources, so callers must await it before mounting.
export const visualTestI18n = i18next.createInstance()

export const visualTestI18nReady = visualTestI18n.use(initReactI18next).init({
	lng: "en",
	fallbackLng: "en",
	ns: ["welcome"],
	defaultNS: "welcome",
	resources: {
		en: {
			welcome: {
				telemetry: {
					helpImprove: visualTestTranslations["welcome:telemetry.helpImprove"],
					helpImproveMessage: visualTestTranslations["welcome:telemetry.helpImproveMessage"],
					accept: visualTestTranslations["welcome:telemetry.accept"],
					decline: visualTestTranslations["welcome:telemetry.decline"],
				},
			},
		},
	},
	interpolation: { escapeValue: false },
})
