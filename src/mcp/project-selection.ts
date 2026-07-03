/**
 * Thrown by the MCP handlers when a project-scoped tool is invoked without an
 * unambiguous project/branch and the user has not selected one this session (and
 * interactive elicitation is unavailable). The tool dispatcher converts it into a
 * normal tool result that instructs the assistant to run `list_projects` first, instead
 * of silently querying a guessed branch.
 */
export class ProjectSelectionRequiredError extends Error {
  constructor(public guidance: string) {
    super(guidance);
    this.name = 'ProjectSelectionRequiredError';
  }
}
