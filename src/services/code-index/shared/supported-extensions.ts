import { extensions as allExtensions } from "../../tree-sitter"
import { fallbackExtensions } from "../../shared/fallback-extensions"

export { fallbackExtensions }

// Include all extensions including markdown for the scanner
export const scannerExtensions = allExtensions
