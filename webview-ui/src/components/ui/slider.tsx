import * as React from "react"
import * as SliderPrimitive from "@radix-ui/react-slider"

import { cn } from "@/lib/utils"

const Slider = React.forwardRef<
	React.ElementRef<typeof SliderPrimitive.Root>,
	React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
	<SliderPrimitive.Root
		ref={ref}
		className={cn("relative flex w-full touch-none select-none items-center", className)}
		{...props}>
		<SliderPrimitive.Track
			data-slot="slider-track"
			className="relative w-full h-[8px] grow overflow-hidden bg-accent rounded-sm border">
			<SliderPrimitive.Range data-slot="slider-range" className="absolute h-full bg-vscode-textLink-foreground" />
		</SliderPrimitive.Track>
		<SliderPrimitive.Thumb
			data-slot="slider-thumb"
			className="block h-3 w-3 rounded-full border-2 border-vscode-editor-background bg-vscode-textLink-foreground outline outline-1 outline-vscode-foreground transition-colors cursor-pointer focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
		/>
	</SliderPrimitive.Root>
))
Slider.displayName = SliderPrimitive.Root.displayName

export { Slider }
