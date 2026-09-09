import React from "react"
import { I18nextProvider } from "react-i18next"

import { TranslationContext } from "@src/i18n/TranslationContext"
import TelemetryBanner from "../TelemetryBanner"
import { visualTestI18n, visualTestTranslations } from "./TelemetryBanner.visual.i18n"

export const TelemetryBannerFixture = () => (
	<I18nextProvider i18n={visualTestI18n}>
		<TranslationContext.Provider
			value={{
				t: (key) => visualTestTranslations[key] ?? key,
				i18n: null as unknown as typeof import("../../../i18n/setup").default,
			}}>
			<TelemetryBanner />
		</TranslationContext.Provider>
	</I18nextProvider>
)
