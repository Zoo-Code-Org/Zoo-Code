import "./vscode-theme-dark.css"
import "@vscode/codicons/dist/codicon.css"
import "../src/index.css"

// Eagerly load the toolkit into the CT entry chunk so lazy component chunks
// reference already-registered custom elements. Splitting the toolkit into a
// separate lazy chunk triggers a Vite 8/Rolldown scope-hoist bug that leaves
// `FoundationElement` in a TDZ (`FoundationElement$N is not defined`).
// See vitejs/vite#22583 and vscode-webview-ui-toolkit#561 (deprecated).
import "@vscode/webview-ui-toolkit/react"
