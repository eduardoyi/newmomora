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

function mapFunctionError(error: { message: string; context?: { status?: number } }): ServiceError {
  return {
    message: error.message,
    code: error.context?.status ? String(error.context.status) : undefined,
  };
}

export async function getUploadUrl(
  objectKey: string,
  contentType: string,
): Promise<{ data: GetUploadUrlResponse | null; error: ServiceError | null }> {
  const { data, error } = await supabase.functions.invoke<GetUploadUrlResponse>('get-upload-url', {
    body: { objectKey, contentType },
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
