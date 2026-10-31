import React from "react"
import { I18nextProvider } from "react-i18next"

import TelemetryBanner from "../TelemetryBanner"
import { visualTestI18n } from "./TelemetryBanner.visual.i18n"

export const TelemetryBannerFixture = () => (
	<I18nextProvider i18n={visualTestI18n}>
		<TelemetryBanner />
	</I18nextProvider>
)
