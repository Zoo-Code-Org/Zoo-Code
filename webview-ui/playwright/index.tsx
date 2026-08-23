import "@vscode/codicons/dist/codicon.css"
import "./themes/vscode-theme-dark.css"
import "./themes/vscode-theme-light.css"
import "./themes/vscode-theme-high-contrast.css"
import "./themes/vscode-theme-high-contrast-light.css"
import "./vscode-theme-base.css"
import "../src/index.css"

// Components read `window.IMAGES_BASE_URI` at mount time to resolve extension
// image assets. Under Playwright CT the extension host isn't present, so seed
// it to serve from the CT bundle root (mapped to src/assets/images via
// `publicDir` in playwright-ct.config.ts).
;(window as unknown as { IMAGES_BASE_URI: string }).IMAGES_BASE_URI = ""
