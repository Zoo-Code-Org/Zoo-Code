/**
 * Kilo Gateway Team Selection Dialog
 *
 * Allows switching between organizations and personal account.
 * Marks the current team with "→ (current)" indicator.
 */

import { DialogSelect } from "@tui/ui/dialog-select"

type Organization = { id: string; name: string; role?: string }

function getOrganizationOptions(organizations: Organization[], current?: string) {
	return [
		{ value: null, title: current ? "Personal" : "Personal (current)" },
		...organizations.map((org) => ({
			value: org.id,
			title: `${org.name}${org.id === current ? " (current)" : ""}`,
		})),
	]
}

interface DialogKiloTeamSelectProps {
	organizations: Organization[]
	currentOrgId?: string | null
	onSelect: (orgId: string | null) => Promise<void>
}

export function DialogKiloTeamSelect(props: DialogKiloTeamSelectProps) {
	// Get formatted options with current markers
	const options = getOrganizationOptions(props.organizations, props.currentOrgId || undefined)

	return (
		<DialogSelect
			title="Select Team"
			options={options}
			current={props.currentOrgId || null}
			onSelect={async (option: any) => {
				await props.onSelect(option.value)
			}}
		/>
	)
}
