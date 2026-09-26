export type ExportJobStatus = 'queued' | 'building' | 'ready' | 'expired' | 'failed';

export interface ExportArchiveRecord {
  /** 1-based position on the download page and in the download URL. */
  index: number;
  /** Private R2 key under exports/<job id>/ -- never shown to the user. */
  key: string;
  /** Human-friendly download name, e.g. "Momora - The Yis - 2026.zip". */
  fileName: string;
  bytes: number;
}

export interface ExportJob {
  id: string;
  owner_user_id: string;
  status: ExportJobStatus;
  expires_at: string;
  family_count: number;
  asset_count: number;
  archives: ExportArchiveRecord[];
  total_bytes: number;
  download_token_hash: string | null;
  started_at: string | null;
  completed_at: string | null;
  failure_code: string | null;
  email_sent_at: string | null;
  files_deleted_at: string | null;
  last_accessed_at: string | null;
  created_at: string;
}

export interface ExportWorkflowParams {
  jobId: string;
  ownerUserId: string;
  /** Origin of the Worker that accepted the request -- download links point here. */
  origin: string;
}

export interface ExportFamily {
  id: string;
  owner_id: string;
  name: string;
  illustration_style: string;
  created_at: string;
}

export interface ExportMember {
  id: string;
  family_id: string;
  user_id: string | null;
  name: string;
  nicknames: string[] | null;
  date_of_birth: string | null;
  gender: string | null;
  profile_picture_key: string | null;
  illustrated_profile_key: string | null;
  illustrated_profile_status: string;
  additional_info: string | null;
  is_user_profile: boolean;
  created_at: string;
}

export interface ExportMemory {
  id: string;
  family_id: string;
  user_id: string | null;
  memory_type: string;
  content: string | null;
  audio_transcript: string | null;
  link_previews: unknown;
  memory_date: string;
  emotion: string | null;
  illustration_key: string | null;
  illustration_status: string;
  media_key: string | null;
  media_content_type: string | null;
  created_at: string;
}

export interface ExportTag {
  memory_id: string;
  family_member_id: string;
}

export interface ExportMedia {
  id: string;
  memory_id: string;
  object_key: string;
  content_type: string;
  duration_ms: number | null;
  position: number;
  created_at: string;
}

export interface ExportComment {
  id: string;
  memory_id: string;
  user_id: string | null;
  content: string;
  created_at: string;
}

export interface ExportPortraitVersion {
  id: string;
  family_id: string;
  family_member_id: string;
  user_id: string | null;
  reference_date: string | null;
  date_source: string;
  profile_picture_key: string;
  illustrated_profile_key: string | null;
  illustrated_profile_status: string;
  created_at: string;
}

export interface ExportProfile {
  id: string;
  name: string;
  timezone: string;
  created_at: string;
}

export type ExportAssetKind =
  | 'memory_photo'
  | 'memory_video'
  | 'memory_audio'
  | 'memory_media'
  | 'memory_illustration'
  | 'family_photo'
  | 'family_portrait'
  | 'portrait_photo'
  | 'portrait_illustration';

/** One entry to write into an archive, in order. */
export type PlannedEntry =
  | { type: 'text'; path: string; text: string; modifiedAt: string; memoryId?: string }
  | {
    type: 'object';
    path: string;
    objectKey: string;
    kind: ExportAssetKind;
    modifiedAt: string;
    memoryId?: string;
    familyMemberId?: string;
    portraitVersionId?: string;
  };

/** One logical archive ("Family & portraits" or one year); may split into parts. */
export interface ArchiveGroup {
  id: string;
  familyId: string;
  kind: 'family' | 'year';
  /** e.g. "Momora - The Yis - 2026" (".zip" and any "(part n of m)" added later). */
  baseName: string;
  entries: PlannedEntry[];
}

export interface ExportPlan {
  jobId: string;
  exportedAt: string;
  ownerUserId: string;
  profile: ExportProfile | null;
  families: ExportFamily[];
  /** Structured data per family, written as that family's manifest.json. */
  familyData: Record<string, FamilyManifestData>;
  /** Top folder every archive of a family shares, e.g. "Momora - The Yis". */
  familyRoots: Record<string, string>;
  /** Year groups first, each family's "Family & portraits" group last (it carries the manifest). */
  groups: ArchiveGroup[];
}

export interface FamilyManifestData {
  familyMembers: ExportMember[];
  memories: ExportMemory[];
  memoryTags: ExportTag[];
  memoryMedia: ExportMedia[];
  memoryComments: ExportComment[];
  portraitVersions: ExportPortraitVersion[];
}

/** What building one group produced -- persisted to R2 between Workflow steps. */
export interface GroupBuildResult {
  groupId: string;
  archives: Array<{ key: string; fileName: string; bytes: number; entryCount: number }>;
  /** Entry paths whose R2 object no longer existed at build time. */
  missing: string[];
}
