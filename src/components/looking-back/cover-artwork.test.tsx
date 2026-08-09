import { render } from '@testing-library/react-native';

import { LookingBackCoverArtwork } from './cover-artwork';
import { useMediaUrls } from '@/hooks/useMediaUrls';

jest.mock('@/hooks/useMediaUrls', () => ({ useMediaUrls: jest.fn() }));
const mockedUseMediaUrls = useMediaUrls as jest.MockedFunction<typeof useMediaUrls>;

const baseMemory = { id: 'm', content: 'A safe memory', emotion: 'joy', illustration_key: null, illustration_status: null, isIllustrationHidden: false, mediaAssets: [], taggedMembers: [], updated_at: '2026-01-01' } as never;

describe('LookingBackCoverArtwork', () => {
  it('renders a real safe illustration cover when its signed URL resolves', () => {
    mockedUseMediaUrls.mockReturnValue({ data: { 'safe.webp': 'https://signed/safe' } } as never);
    const { getByTestId } = render(<LookingBackCoverArtwork memories={[{ ...baseMemory, illustration_key: 'safe.webp', illustration_status: 'ready' } as never]} testID="cover" />);
    expect(getByTestId('cover')).toBeTruthy();
  });

  it('uses a nonblank emotion print when a reported illustration is hidden', () => {
    mockedUseMediaUrls.mockReturnValue({ data: {} } as never);
    const { getByTestId, getByText } = render(<LookingBackCoverArtwork memories={[{ ...baseMemory, illustration_key: 'hidden.webp', illustration_status: 'ready', isIllustrationHidden: true } as never]} testID="cover" />);
    expect(getByTestId('cover')).toBeTruthy();
    expect(getByText('”')).toBeTruthy();
  });
});
