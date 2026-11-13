import React from "react"
import { I18nextProvider } from "react-i18next"

import { TranslationContext } from "@src/i18n/TranslationContext"
import TelemetryBanner from "../TelemetryBanner"
import { visualTestI18n } from "./TelemetryBanner.visual.i18n"

export const TelemetryBannerFixture = () => (
	<I18nextProvider i18n={visualTestI18n}>
		<TranslationContext.Provider value={{ t: visualTestI18n.getFixedT("en"), language: "en" }}>
			<TelemetryBanner />
		</TranslationContext.Provider>
	</I18nextProvider>
)
