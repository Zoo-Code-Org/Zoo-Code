import { extensions as allExtensions } from "../../tree-sitter/extensions"
import { fallbackExtensions } from "../../shared/fallback-extensions"

export { fallbackExtensions }

// Include all extensions including markdown for the scanner
export const scannerExtensions = allExtensions
