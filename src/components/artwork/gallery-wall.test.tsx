import { render } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';

import { GALLERY_WALL_COLOR, GalleryWall } from '@/components/artwork/gallery-wall';

describe('GalleryWall', () => {
  it('is a plaster-colored wall with children above a faint tiling noise and a light streak', () => {
    const { getByTestId, getByText } = render(
      <GalleryWall testID="wall">
        <Text>on the wall</Text>
      </GalleryWall>,
    );

    expect(StyleSheet.flatten(getByTestId('wall').props.style)).toMatchObject({
      backgroundColor: GALLERY_WALL_COLOR,
      flex: 1,
    });
    expect(GALLERY_WALL_COLOR).toBe('#EEE3D3');
    // The decoration is hidden from accessibility.
    expect(getByTestId('wall-noise', { hidden: true })).toBeTruthy();
    expect(getByTestId('wall-light', { hidden: true })).toBeTruthy();
    expect(getByText('on the wall')).toBeTruthy();
  });
});
