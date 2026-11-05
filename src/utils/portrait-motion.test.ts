import { getPortraitMotion } from '@/utils/portrait-motion';

const ready = {
  illustrated_profile_key: 'u/family/m/portraits/v1/still.webp',
  motion_status: 'ready' as const,
  motion_key: 'u/family/m/portraits/v1/motion/t.webp',
  motion_source_key: 'u/family/m/portraits/v1/still.webp',
  motion_columns: 3,
  motion_rows: 3,
};

describe('getPortraitMotion', () => {
  it('returns the sheet for a ready motion made from the current still', () => {
    expect(getPortraitMotion(ready)).toEqual({
      key: 'u/family/m/portraits/v1/motion/t.webp',
      columns: 3,
      rows: 3,
    });
  });

  it('returns null without a version or for a row that predates the motion columns', () => {
    expect(getPortraitMotion(null)).toBeNull();
    expect(getPortraitMotion(undefined)).toBeNull();
    expect(getPortraitMotion({ illustrated_profile_key: ready.illustrated_profile_key })).toBeNull();
  });

  it('returns null unless motion_status is ready', () => {
    expect(getPortraitMotion({ ...ready, motion_status: 'pending' })).toBeNull();
    expect(getPortraitMotion({ ...ready, motion_status: 'failed' })).toBeNull();
    expect(getPortraitMotion({ ...ready, motion_status: null })).toBeNull();
  });

  it('returns null without a motion key', () => {
    expect(getPortraitMotion({ ...ready, motion_key: null })).toBeNull();
    expect(getPortraitMotion({ ...ready, motion_key: '' })).toBeNull();
  });

  it('returns null when the sheet was made from a different still', () => {
    expect(getPortraitMotion({ ...ready, motion_source_key: 'other-still.webp' })).toBeNull();
    expect(getPortraitMotion({ ...ready, motion_source_key: null })).toBeNull();
  });

  it('returns null when the still itself is not published', () => {
    expect(getPortraitMotion({ ...ready, illustrated_profile_key: null, motion_source_key: null })).toBeNull();
  });

  it('requires integer columns and rows between 1 and 4', () => {
    expect(getPortraitMotion({ ...ready, motion_columns: 1, motion_rows: 4 })).not.toBeNull();
    for (const bad of [0, 5, 2.5, -1, null, undefined]) {
      expect(getPortraitMotion({ ...ready, motion_columns: bad })).toBeNull();
      expect(getPortraitMotion({ ...ready, motion_rows: bad })).toBeNull();
    }
  });
});
