import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

import { supabase } from '@/lib/supabase';

export interface ServiceError {
  message: string;
  code?: string;
}

export interface GetUploadUrlResponse {
  uploadUrl: string;
  objectKey: string;
  expiresIn: number;
}

export interface GetMediaUrlResponse {
  urls: Record<string, string>;
  expiresIn: number;
}

export interface UploadMediaResponse {
  objectKey: string;
  success: true;
}

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;

function mapFunctionError(error: { message: string; context?: { status?: number } }): ServiceError {
  return {
    message: error.message,
    code: error.context?.status ? String(error.context.status) : undefined,
  };
}

async function mapResponseError(response: Response): Promise<ServiceError> {
  try {
    const body = await response.json();
    if (body && typeof body.error === 'string') {
      return {
        message: body.error,
        code: typeof body.code === 'string' ? body.code : String(response.status),
      };
    }
  } catch {
    // Fall through to generic status-based message.
  }

  return {
    message: 'Media upload failed',
    code: String(response.status),
  };
}

async function getUploadFunctionHeaders(
  objectKey: string,
  contentType: string,
  familyId: string,
): Promise<{ headers: Record<string, string>; error: ServiceError | null }> {
  const { data, error } = await supabase.auth.getSession();
  const token = data.session?.access_token;

  if (error || !token) {
    return {
      headers: {},
      error: {
        message: error?.message ?? 'You must be signed in to upload media',
        code: 'unauthorized',
      },
    };
  }

  return {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType,
      'x-object-key': objectKey,
      'x-family-id': familyId,
    },
    error: null,
  };
}

function getUploadFunctionUrl(): string {
  if (!supabaseUrl) {
    throw new Error('Missing EXPO_PUBLIC_SUPABASE_URL');
  }

  return `${supabaseUrl.replace(/\/$/, '')}/functions/v1/upload-media`;
}

export async function getUploadUrl(
  objectKey: string,
  contentType: string,
  familyId: string,
): Promise<{ data: GetUploadUrlResponse | null; error: ServiceError | null }> {
  const { data, error } = await supabase.functions.invoke<GetUploadUrlResponse>('get-upload-url', {
    body: { objectKey, contentType, familyId },
  });

  if (error) {
    return { data: null, error: mapFunctionError(error) };
  }

  if (!data?.uploadUrl) {
    return { data: null, error: { message: 'Upload URL was not returned' } };
  }

  return { data, error: null };
}

export async function getMediaUrls(
  keys: string[],
): Promise<{ data: GetMediaUrlResponse | null; error: ServiceError | null }> {
  const { data, error } = await supabase.functions.invoke<GetMediaUrlResponse>('get-media-url', {
    body: { keys },
  });

  if (error) {
    return { data: null, error: mapFunctionError(error) };
  }

  if (!data?.urls) {
    return { data: null, error: { message: 'Media URLs were not returned' } };
  }

  return { data, error: null };
}

export async function uploadMediaObject(
  objectKey: string,
  fileUri: string,
  contentType: string,
  familyId: string,
): Promise<{ data: UploadMediaResponse | null; error: ServiceError | null }> {
  const { headers, error: authError } = await getUploadFunctionHeaders(
    objectKey,
    contentType,
    familyId,
  );
  if (authError) {
    return { data: null, error: authError };
  }

  const uploadUrl = getUploadFunctionUrl();

  if (Platform.OS === 'web') {
    const fileResponse = await fetch(fileUri);
    const blob = await fileResponse.blob();

    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers,
      body: blob,
    });

    if (!uploadResponse.ok) {
      return { data: null, error: await mapResponseError(uploadResponse) };
    }

    return { data: await uploadResponse.json(), error: null };
  }

  const uploadResult = await FileSystem.uploadAsync(uploadUrl, fileUri, {
    httpMethod: 'POST',
    headers,
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
  });

  if (uploadResult.status < 200 || uploadResult.status >= 300) {
    try {
      const body = JSON.parse(uploadResult.body);
      if (body && typeof body.error === 'string') {
        return {
          data: null,
          error: {
            message: body.error,
            code: typeof body.code === 'string' ? body.code : String(uploadResult.status),
          },
        };
      }
    } catch {
      // Fall through to generic status-based message.
    }

    return {
      data: null,
      error: {
        message: 'Media upload failed',
        code: String(uploadResult.status),
      },
    };
  }

  return {
    data: {
      objectKey,
      success: true,
    },
    error: null,
  };
}

export async function uploadToPresignedUrl(
  uploadUrl: string,
  fileUri: string,
  contentType: string,
): Promise<{ error: ServiceError | null }> {
  if (Platform.OS === 'web') {
    const response = await fetch(fileUri);
    const blob = await response.blob();

    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
      },
      body: blob,
    });

    if (!uploadResponse.ok) {
      return {
        error: {
          message: 'Photo upload failed',
          code: String(uploadResponse.status),
        },
      };
    }

    return { error: null };
  }

  const uploadResult = await FileSystem.uploadAsync(uploadUrl, fileUri, {
    httpMethod: 'PUT',
    headers: {
      'Content-Type': contentType,
    },
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
  });

  if (uploadResult.status < 200 || uploadResult.status >= 300) {
    return {
      error: {
        message: 'Photo upload failed',
        code: String(uploadResult.status),
      },
    };
  }

  return { error: null };
}

export async function deleteStorageObject(
  objectKey: string,
): Promise<{ error: ServiceError | null }> {
  const { error } = await supabase.functions.invoke('delete-storage-object', {
    body: { objectKey },
  });

  if (error) {
    return { error: mapFunctionError(error) };
  }

  return { error: null };
}
