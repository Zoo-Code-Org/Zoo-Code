import { t } from "../../../../i18n"

export function requireSetting(value: string | undefined, errorKey: string): string {
	if (!value) {
		throw new Error(t(errorKey))
	}
	return value
}
