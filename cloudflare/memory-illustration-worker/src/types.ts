export const WORKFLOW_JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type IllustrationModel = 'gpt-image-2' | 'gpt-image-1.5';

export type BridgeOperation =
  | 'get_input'
  | 'reserve_attempt'
  | 'record_usage'
  | 'record_prompt'
  | 'authorize_upload'
  | 'record_upload_complete'
  | 'publish'
  | 'fail'
  | 'reconcile'
  | 'retrigger_memories';

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
interface WorkflowJobInputBase {
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

/** Grandfathered jobs created before fair-use enforcement. */
export interface WorkflowJobInputV1 extends WorkflowJobInputBase {
  providerProtocolVersion?: 1;
  usageRequestId?: never;
}

/** Jobs created after activation. These must use the strict v2 bridge contract. */
export interface WorkflowJobInputV2 extends WorkflowJobInputBase {
  providerProtocolVersion: 2;
  usageRequestId: string;
}

export type WorkflowJobInput = WorkflowJobInputV1 | WorkflowJobInputV2;

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
  outcome: 'reserved_now' | 'already_reserved' | 'denied';
  protocolVersion: 2;
}

export interface ImageUsage {
  inputTextTokens: number | null;
  inputImageTokens: number | null;
  inputCachedTokens: number | null;
  outputTextTokens: number | null;
  outputImageTokens: number | null;
}

export interface ImageProviderResult {
  bytes: ArrayBuffer;
  usage: ImageUsage | null;
}

export interface BridgeAuthorizeUploadResponse {
  authorized: boolean;
  uploadToken: string | null;
  existingLease: boolean;
}

export interface BridgeRecordUploadCompleteResponse {
  completed: boolean;
}

export interface BridgeFailResponse {
  failed: boolean;
  outputKey: string | null;
  deleteOutput: boolean;
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

/**
 * Portrait input is frozen by the Supabase dispatcher. It is read only within
 * the Workflow's sensitive image-generation step and must never be returned
 * from a step or logged.
 */
interface PortraitWorkflowJobInputBase {
  jobId: string;
  outputKey: string;
  oldPortraitKey: string | null;
  providerDeadlineAt: string;
  prompt: string;
  sourcePhotoKey: string;
  styleReferenceKey: string;
}

export interface PortraitWorkflowJobInputV1 extends PortraitWorkflowJobInputBase {
  providerProtocolVersion?: 1;
  usageRequestId?: never;
}

export interface PortraitWorkflowJobInputV2 extends PortraitWorkflowJobInputBase {
  providerProtocolVersion: 2;
  usageRequestId: string;
}

export type PortraitWorkflowJobInput = PortraitWorkflowJobInputV1 | PortraitWorkflowJobInputV2;

export interface BridgePortraitGetInputResponse {
  job: PortraitWorkflowJobInput;
}

export interface BridgePortraitReserveAttemptResponse {
  outcome: 'reserved_now' | 'already_reserved' | 'denied';
  protocolVersion: 2;
}

export interface BridgePortraitPublishResponse {
  published: boolean;
  oldPortraitKey: string | null;
  deleteOutput: boolean;
}

export interface BridgePortraitReconcileResponse {
  published: boolean;
  oldPortraitKey: string | null;
  deleteOutput: boolean;
}

export interface BridgePortraitFailResponse {
  failed: boolean;
  outputKey: string | null;
  deleteOutput: boolean;
}

export interface PortraitLoadedReferences {
  style: LoadedReference;
  source: LoadedReference;
}
