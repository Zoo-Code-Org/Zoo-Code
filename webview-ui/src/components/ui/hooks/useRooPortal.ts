import { useEffect, useState } from "react"

export const useRooPortal = (id: string) => {
	const [container, setContainer] = useState<HTMLElement>()

	// Use useEffect instead of react-use's useMount: the Playwright CT ESM
	// transform fails on `import { useMount } from "react-use"` (no named
	// export in the module graph resolved under component tests). Runs once on
	// mount, exactly like useMount did.
	useEffect(() => {
		setContainer(document.getElementById(id) ?? undefined)
		// eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only, mirrors useMount semantics
	}, [])

	return container
}
