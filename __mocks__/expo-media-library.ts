// Global Jest stand-in for expo-media-library (mapped in jest.config.js).
//
// The real module's ESM entry cannot be evaluated under jest-expo ("Super
// expression must either be null or a function" from its class-based Query/
// Asset/Album API). Only src/utils/gallery-import-scanner.ts imports it for
// real, but since the continuous gallery-import driver (src/services/
// gallery-import-driver.ts) is mounted at the app root and reached from
// src/hooks/useGalleryImport.ts, any screen test that renders Settings or the
// Timeline now transitively imports the scanner. This mock keeps those suites
// loadable; gallery-import-scanner.test.ts still declares its own richer
// jest.mock, which takes precedence there.
import { jest } from '@jest/globals';

export const AssetField = { MEDIA_TYPE: 'mediaType', CREATION_TIME: 'creationTime' };
export const MediaType = { IMAGE: 'image', VIDEO: 'video' };
export const MediaSubtype = { SCREENSHOT: 'screenshot' };

export class Query {
  album(): this { return this; }
  eq(): this { return this; }
  gt(): this { return this; }
  lt(): this { return this; }
  orderBy(): this { return this; }
  limit(): this { return this; }
  offset(): this { return this; }
  async exe(): Promise<unknown[]> { return []; }
}

export const Asset = jest.fn();
export const Album = { get: jest.fn(async () => null) };

export const getPermissionsAsync = jest.fn(async () => ({ status: 'undetermined', granted: false, canAskAgain: true, accessPrivileges: 'none' }));
export const requestPermissionsAsync = jest.fn(async () => ({ status: 'undetermined', granted: false, canAskAgain: true, accessPrivileges: 'none' }));
export const presentPermissionsPicker = jest.fn(async () => undefined);
export const getAssetInfoAsync = jest.fn(async () => null);

export type PermissionResponse = {
  status: string;
  granted: boolean;
  canAskAgain: boolean;
  accessPrivileges?: 'all' | 'limited' | 'none';
};
