import { render } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';

import { ArtworkFrame } from '@/components/artwork-frame';
import { colors } from '@/constants/theme';

describe('ArtworkFrame', () => {
  it('renders children inside the frame, mat and opening layers', () => {
    const { getByTestId } = render(
      <ArtworkFrame testID="frame">
        <Text testID="child">drawing</Text>
      </ArtworkFrame>,
    );

    const opening = getByTestId('frame-opening');
    expect(opening).toContainElement(getByTestId('child'));
    expect(getByTestId('frame-mat')).toContainElement(opening);
    expect(getByTestId('frame-lip')).toContainElement(getByTestId('frame-mat'));
    expect(getByTestId('frame-band')).toContainElement(getByTestId('frame-lip'));
    expect(getByTestId('frame')).toContainElement(getByTestId('frame-band'));
  });

  it('draws a wood band, cream mat and shaded mat opening from theme tokens', () => {
    const { getByTestId } = render(
      <ArtworkFrame testID="frame">
        <Text>drawing</Text>
      </ArtworkFrame>,
    );

    const band = StyleSheet.flatten(getByTestId('frame-band').props.style);
    expect(band.backgroundColor).toBe(colors.frameWood);
    expect(band.borderTopColor).toBe(colors.frameWoodLight);
    expect(band.borderBottomColor).toBe(colors.frameWoodDark);

    const mat = StyleSheet.flatten(getByTestId('frame-mat').props.style);
    expect(mat.backgroundColor).toBe(colors.frameMat);

    const opening = StyleSheet.flatten(getByTestId('frame-opening').props.style);
    expect(opening.borderTopColor).toBe(colors.frameMatShade);
    expect(opening.overflow).toBe('hidden');
  });

  it('uses fixed, deterministic padding that is larger on the detail size', () => {
    const card = render(
      <ArtworkFrame size="card" testID="card-frame">
        <Text>x</Text>
      </ArtworkFrame>,
    );
    const detail = render(
      <ArtworkFrame size="detail" testID="detail-frame">
        <Text>x</Text>
      </ArtworkFrame>,
    );

    const cardBand = StyleSheet.flatten(card.getByTestId('card-frame-band').props.style);
    const detailBand = StyleSheet.flatten(detail.getByTestId('detail-frame-band').props.style);
    const cardMat = StyleSheet.flatten(card.getByTestId('card-frame-mat').props.style);
    const detailMat = StyleSheet.flatten(detail.getByTestId('detail-frame-mat').props.style);

    expect(cardBand.padding).toBe(8);
    expect(cardMat.padding).toBe(14);
    expect(detailBand.padding).toBeGreaterThan(cardBand.padding as number);
    expect(detailMat.padding).toBeGreaterThan(cardMat.padding as number);
  });

  it('defaults to the card size and merges a caller style onto the outer shadow layer', () => {
    const { getByTestId } = render(
      <ArtworkFrame style={{ marginTop: 3 }} testID="frame">
        <Text>x</Text>
      </ArtworkFrame>,
    );

    const outer = StyleSheet.flatten(getByTestId('frame').props.style);
    expect(outer.marginTop).toBe(3);
    expect(outer.shadowColor).toBe(colors.frameShadow);
    expect(StyleSheet.flatten(getByTestId('frame-band').props.style).padding).toBe(8);
  });
});
