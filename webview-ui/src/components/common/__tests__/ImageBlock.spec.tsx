import { render, screen } from "@/utils/test-utils"

import ImageBlock from "../ImageBlock"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => (key === "common:image.generatedAlt" ? "AI Generated Image" : key),
	}),
}))

vi.mock("../ImageViewer", () => ({
	ImageViewer: ({ alt }: { alt?: string }) => <img alt={alt} data-testid="image-viewer" />,
}))

describe("ImageBlock", () => {
	it("passes the translated alt text to the image viewer", () => {
		render(<ImageBlock imageUri="vscode-webview://example.png" imagePath="/tmp/example.png" />)

		expect(screen.getByTestId("image-viewer")).toHaveAttribute("alt", "AI Generated Image")
	})
})
