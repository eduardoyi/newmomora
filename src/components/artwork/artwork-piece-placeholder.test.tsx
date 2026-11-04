import { render } from '@testing-library/react-native';
import { ActivityIndicator } from 'react-native';

import { ArtworkPiece } from '@/components/artwork/artwork-piece';
import { artworkAsset } from '@/components/artwork/artwork-test-fixtures';

// Detail shows the original (decision C6), with the Timeline's list-sized
// preview as a placeholder -- same cacheKey the Timeline card pins
// (mediaImageSource(url, displayKey) => cacheKey = preview key).

const asset = artworkAsset(1);
const ORIGINAL = 'https://r2.test/original.jpg';
const PREVIEW = 'https://r2.test/preview.jpg';

function renderPiece(props: { url?: string; placeholderUrl?: string; asset?: typeof asset }) {
  return render(
    <ArtworkPiece
      accessibilityLabel="piece"
      artWidth={200}
      asset={props.asset ?? asset}
      memoryId="memory-1"
      placeholderUrl={props.placeholderUrl}
      url={props.url}
    />,
  );
}

describe('ArtworkPiece preview placeholder', () => {
  it('shows the cached preview (not a spinner) while the original URL is unsigned', () => {
    const { getByTestId, UNSAFE_queryByType } = renderPiece({ placeholderUrl: PREVIEW });

    expect(UNSAFE_queryByType(ActivityIndicator)).toBeNull();
    expect(getByTestId('memory-media-image-asset-1').props.source).toEqual([
      { uri: PREVIEW, cacheKey: asset.preview_object_key },
    ]);
  });

  it('upgrades to the original (cacheKey = object key) with the preview as placeholder', () => {
    const { getByTestId } = renderPiece({ url: ORIGINAL, placeholderUrl: PREVIEW });
    const image = getByTestId('memory-media-image-asset-1');

    expect(image.props.source).toEqual([{ uri: ORIGINAL, cacheKey: asset.object_key }]);
    expect(image.props.placeholder).toEqual([{ uri: PREVIEW, cacheKey: asset.preview_object_key }]);
    expect(image.props.transition).toEqual({ duration: 150 });
  });

  it('keeps the spinner when neither URL has arrived', () => {
    const { UNSAFE_queryByType } = renderPiece({});

    expect(UNSAFE_queryByType(ActivityIndicator)).not.toBeNull();
  });

  it('ignores a placeholder URL for an asset with no distinct preview', () => {
    const { UNSAFE_queryByType } = renderPiece({
      placeholderUrl: PREVIEW,
      asset: artworkAsset(1, { preview_object_key: null }),
    });

    expect(UNSAFE_queryByType(ActivityIndicator)).not.toBeNull();
  });
});
