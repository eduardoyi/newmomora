export interface ExportJob {
  id: string;
  owner_user_id: string;
  status: 'ready' | 'expired' | 'failed';
  expires_at: string;
  family_count: number;
  asset_count: number;
  last_accessed_at: string | null;
  created_at: string;
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
  content: string | null;
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
  preview_object_key: string | null;
  preview_content_type: string | null;
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
  generation_output_key: string | null;
  created_at: string;
}

export interface ExportProfile {
  id: string;
  name: string;
  timezone: string;
  illustration_style: string;
  created_at: string;
}

export interface ExportAsset {
  path: string;
  kind: 'memory_media' | 'memory_media_preview' | 'memory_illustration' | 'family_photo' | 'family_portrait' | 'portrait_photo' | 'portrait_illustration' | 'portrait_attempt';
  contentType: string | null;
  familyId: string;
  memoryId?: string;
  familyMemberId?: string;
  portraitVersionId?: string;
  exists: boolean;
  bytes?: number;
  objectKey: string;
}

export interface ExportManifest {
  format: 'momora-export';
  version: 1;
  exportedAt: string;
  ownerUserId: string;
  profile: ExportProfile | null;
  families: ExportFamily[];
  familyMembers: ExportMember[];
  memories: ExportMemory[];
  memoryTags: ExportTag[];
  memoryMedia: ExportMedia[];
  portraitVersions: ExportPortraitVersion[];
  assets: Array<Omit<ExportAsset, 'objectKey'>>;
  missingAssets: string[];
}
