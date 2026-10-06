/** A Workflow `create` with an id that already exists (a retried dispatch of
 * the same attempt): success, not a failure. (Also matches `instance.already_exists`.) */
export function isDuplicate(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already[ _.]?exists|duplicate|unique/i.test(message);
}

/** Starts a YearFilmWorkflow instance for a claimed film attempt, exactly like
 * /dispatch: instance id = film attempt id, a duplicate is success, any other
 * failure throws. Used by the holiday card Workflow (direct binding, no HTTP). */
export async function startFilmWorkflow(
  workflow: { create(options: { id: string; params: { filmId: string; attemptId: string }; retention: { successRetention: '1 day'; errorRetention: '1 day' } }): Promise<unknown> },
  filmId: string,
  filmAttemptId: string,
): Promise<void> {
  try {
    await workflow.create({
      id: filmAttemptId,
      params: { filmId, attemptId: filmAttemptId },
      retention: { successRetention: '1 day', errorRetention: '1 day' },
    });
  } catch (error) {
    if (!isDuplicate(error)) throw error;
  }
}
