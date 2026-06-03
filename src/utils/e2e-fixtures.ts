import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';

export interface E2eProfilePhoto {
  uri: string;
  contentType: string;
}

const E2E_PROFILE_FIXTURE_CACHE_URI = `${FileSystem.cacheDirectory}e2e-profile-fixture.jpg`;

export const E2E_FAMILY_MEMBER_NAME = 'Maestro Test Child';
export const E2E_FAMILY_MEMBER_DOB = '2022-10-25';
export const E2E_FAMILY_MEMBER_GENDER = 'Male';
export const E2E_FAMILY_MEMBER_NOTES = 'E2E profile upload';

export function isE2eFixturesEnabled(): boolean {
  return __DEV__;
}

export async function loadE2eProfilePhoto(): Promise<E2eProfilePhoto> {
  const moduleId = require('../../assets/e2e/profile-fixture.jpg');
  const asset = Asset.fromModule(moduleId);
  await asset.downloadAsync();

  const sourceUri = asset.localUri ?? asset.uri;

  if (!sourceUri) {
    throw new Error('E2E profile fixture could not be loaded');
  }

  await FileSystem.copyAsync({
    from: sourceUri,
    to: E2E_PROFILE_FIXTURE_CACHE_URI,
  });

  return {
    uri: E2E_PROFILE_FIXTURE_CACHE_URI,
    contentType: 'image/jpeg',
  };
}
