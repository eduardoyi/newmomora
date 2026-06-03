import * as ImageManipulator from 'expo-image-manipulator';
import { Image } from 'react-native';

import {
  MAX_PROFILE_PHOTO_EDGE,
  PROFILE_PHOTO_UPLOAD_QUALITY,
} from '@/constants/image-limits';

export interface PreparedProfilePhoto {
  uri: string;
  contentType: string;
}

export function buildProfilePhotoResizeActions(
  width: number,
  height: number,
  maxEdge = MAX_PROFILE_PHOTO_EDGE,
): ImageManipulator.Action[] {
  const largestEdge = Math.max(width, height);

  if (largestEdge <= maxEdge) {
    return [];
  }

  if (width >= height) {
    return [{ resize: { width: maxEdge } }];
  }

  return [{ resize: { height: maxEdge } }];
}

function getImageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    Image.getSize(
      uri,
      (width, height) => resolve({ width, height }),
      (error) => reject(error),
    );
  });
}

export async function prepareProfilePhotoForUpload(uri: string): Promise<PreparedProfilePhoto> {
  const { width, height } = await getImageSize(uri);
  const result = await ImageManipulator.manipulateAsync(
    uri,
    buildProfilePhotoResizeActions(width, height),
    {
      compress: PROFILE_PHOTO_UPLOAD_QUALITY,
      format: ImageManipulator.SaveFormat.JPEG,
    },
  );

  return {
    uri: result.uri,
    contentType: 'image/jpeg',
  };
}
