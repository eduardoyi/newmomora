/* eslint-disable */
interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  MEDIA: MomoraExportR2Bucket;
}

interface MomoraExportR2ObjectMetadata {
  size: number;
}

interface MomoraExportR2ObjectBody extends MomoraExportR2ObjectMetadata {
  body: ReadableStream<Uint8Array>;
}

interface MomoraExportR2Bucket {
  head(key: string): Promise<MomoraExportR2ObjectMetadata | null>;
  get(key: string): Promise<MomoraExportR2ObjectBody | null>;
}
