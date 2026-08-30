import "@vscode/codicons/dist/codicon.css"
import "../themes/vscode-theme-dark.css"
import "../themes/vscode-theme-light.css"
import "../themes/vscode-theme-high-contrast.css"
import "../themes/vscode-theme-high-contrast-light.css"
import "../vscode-theme-base.css"
import "./gallery.css"

import { createRoot } from "react-dom/client"

import { stories } from "./stories"

type StoryProps = Record<string, unknown>

declare global {
	interface Window {
		IMAGES_BASE_URI: string
		mount: (options: { story: string; props?: StoryProps }) => Promise<void>
		unmount: () => Promise<void>
	}
}

const galleryContainer = document.querySelector<HTMLElement>("#root")
if (!galleryContainer) throw new Error("Playwright gallery root is missing")
const container: HTMLElement = galleryContainer

const root = createRoot(container)

const afterRender = () =>
	new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

async function waitForRoot(predicate: (element: Element | null) => boolean, message: string) {
	for (let frame = 0; frame < 120; frame++) {
		if (predicate(container.firstElementChild)) return
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	}
	throw new Error(message)
}

window.IMAGES_BASE_URI = ""

window.unmount = async () => {
	root.render(null)
	await waitForRoot((element) => element === null, "Playwright gallery story did not unmount")
	container
		.querySelectorAll("[data-playwright-mounted]")
		.forEach((element) => element.removeAttribute("data-playwright-mounted"))
	window.__vscodeMessages = []
}

window.mount = async ({ story, props = {} }) => {
	const renderStory = stories[story]
	if (!renderStory) {
		throw new Error(
			`Unknown Playwright gallery story "${story}". Available stories: ${Object.keys(stories).join(", ")}`,
		)
	}

	await window.unmount()
	const storyNode = await renderStory(props)
	root.render(storyNode)
	await waitForRoot((element) => element !== null, `Playwright gallery story "${story}" rendered no root element`)
	await afterRender()

	const mounted = container.firstElementChild
	if (!mounted) throw new Error(`Playwright gallery story "${story}" disappeared after rendering`)
	mounted.setAttribute("data-playwright-mounted", story)
}
