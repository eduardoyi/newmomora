export const WORKFLOW_JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type IllustrationModel = 'gpt-image-2' | 'gpt-image-1.5';

export type BridgeOperation =
  | 'get_input'
  | 'reserve_attempt'
  | 'record_prompt'
  | 'publish'
  | 'fail'
  | 'reconcile';

export interface ReferenceCandidate {
  memberId: string;
  description: string;
  portraitKey: string | null;
  portraitContentType: string | null;
  profileKey: string | null;
  profileContentType: string | null;
}

/**
 * The only sensitive payload crosses the bridge inside the generating step.
 * This object must never be returned from a Workflow step or logged.
 */
export interface WorkflowJobInput {
  jobId: string;
  outputKey: string;
  oldIllustrationKey: string | null;
  providerDeadlineAt: string;
  safeSceneDescription: string;
  expressionStyle: string | null;
  styleDescription: string;
  colorPalette: string;
  emotion: string | null;
  memoryDate: string;
  referenceCandidates: ReferenceCandidate[];
}

export interface LoadedReference {
  description: string;
  bytes: ArrayBuffer;
}

export interface GenerationStepResult {
  outputKey: string;
  model: IllustrationModel;
}

export interface BridgeGetInputResponse {
  job: WorkflowJobInput;
}

export interface BridgeReserveAttemptResponse {
  reserved: boolean;
}

export interface BridgePublishResponse {
  published: boolean;
  oldIllustrationKey: string | null;
  deleteOutput: boolean;
}

export interface BridgeReconcileResponse {
  published: boolean;
  oldIllustrationKey: string | null;
  deleteOutput: boolean;
}

export interface WorkflowDispatchPayload {
  jobId: string;
}
