export function isDuplicateWorkflowError(error: unknown): boolean {
  // The Workflows binding surfaces a duplicate-instance-id rejection as a
  // plain Error with a human-readable message (no documented numeric code
  // in @cloudflare/workers-types' `WorkflowError` as of this writing); match
  // its wording rather than relying on an unstable code.
  const message = error instanceof Error ? error.message : '';
  return /already exists|duplicate|unique/i.test(message);
}
