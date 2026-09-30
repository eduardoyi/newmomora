export const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface Env {
  ENVIRONMENT: string;
  SUPABASE_BRIDGE_URL: string;
  DISPATCH_SIGNING_SECRET: string;
  SUPABASE_BRIDGE_HMAC_SECRET: string;
  OPENAI_API_KEY: string;
  FLY_API_TOKEN: string;
  FLY_APP: string;
  FILM_RENDERER_IMAGE: string;
  FLY_REGIONS: string;
  /** Optional: per-machine R2 credentials (plan Decision 3). Without them
   * the machines fall back to the Fly app's own R2 secrets. */
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  R2_PARENT_ACCESS_KEY_ID?: string;
  R2_BUCKET_NAME: string;
  SENTRY_DSN?: string;
  FILM_BUCKET: R2Bucket;
  YEAR_FILM_WORKFLOW: Workflow;
}

export interface DispatchPayload {
  filmId: string;
  attemptId: string;
}

/** Closed failure-code set persisted as last_failure_code (never raw errors). */
export type FailureCode =
  | 'CONTEXT_LOAD_FAILED'
  | 'CURATE_FAILED'
  | 'MACHINE_FAILED'
  | 'MACHINE_TIMEOUT'
  | 'IMAGE_INCOMPLETE'
  | 'CHECKS_FAILED'
  | 'RENDER_QUEUE_TIMEOUT'
  | 'PUBLISH_FAILED'
  | 'UNKNOWN_ERROR';
