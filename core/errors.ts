/** A start failure; `ownedPaneId` names a pane this call proved it created and must close. */
export class StartAgentError extends Error {
	constructor(
		readonly kind: "validation" | "layout" | "uncertain-create" | "startup" | "compensation",
		message: string,
		readonly ownedPaneId?: string,
	) {
		super(message);
		this.name = "StartAgentError";
	}
}
