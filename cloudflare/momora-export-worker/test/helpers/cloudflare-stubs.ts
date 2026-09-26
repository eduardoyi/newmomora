// Node-side stand-ins for the workerd-only modules, aliased in
// vitest.config.ts. Just enough surface for the Workflow class to load and
// run under a fake step.
export class WorkflowEntrypoint<E = unknown> {
  protected env: E;
  protected ctx: unknown;
  constructor(ctx: unknown, env: E) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}
