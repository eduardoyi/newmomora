import { buildProfilePhotoResizeActions } from '@/utils/profile-photo';

describe('buildProfilePhotoResizeActions', () => {
  it('returns no actions when the image is already within the max edge', () => {
    expect(buildProfilePhotoResizeActions(1600, 1200)).toEqual([]);
  });

  it('caps width for landscape photos', () => {
    expect(buildProfilePhotoResizeActions(4032, 3024)).toEqual([{ resize: { width: 2048 } }]);
  });

  it('caps height for portrait photos', () => {
    expect(buildProfilePhotoResizeActions(3024, 4032)).toEqual([{ resize: { height: 2048 } }]);
  });
});
