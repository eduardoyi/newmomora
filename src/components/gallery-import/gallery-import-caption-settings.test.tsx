import { act, fireEvent, render } from '@testing-library/react-native';
import { Dimensions, Keyboard, StyleSheet } from 'react-native';

import {
  GalleryImportCaptionSettingsScreen,
  computeGalleryCaptionLocalePickerSheetMetrics,
  getGalleryCaptionLocalePickerKeyboardAvoidingBehavior,
} from '@/components/gallery-import/gallery-import-caption-settings';
import { curatedGalleryCaptionLocaleTags } from '@/constants/gallery-caption-locales';
import { useGalleryCaptionSettings } from '@/hooks/useGalleryImport';
import { useFamily } from '@/hooks/use-family';
import { getRecentGalleryCaptionLocales, recordGalleryCaptionLocaleRecent } from '@/utils/gallery-caption-locale-recents';

jest.mock('expo-router', () => ({ router: { back: jest.fn() } }));
jest.mock('react-native-safe-area-context', () => {
  const { View: MockView } = require('react-native');
  return { SafeAreaView: MockView, useSafeAreaInsets: () => ({ bottom: 28, top: 0, left: 0, right: 0 }) };
});
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useGalleryImport', () => ({ useGalleryCaptionSettings: jest.fn() }));
jest.mock('@/utils/gallery-caption-locale-recents', () => ({
  getRecentGalleryCaptionLocales: jest.fn(),
  recordGalleryCaptionLocaleRecent: jest.fn(),
}));

const mockedFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedCaptionSettings = useGalleryCaptionSettings as jest.MockedFunction<typeof useGalleryCaptionSettings>;
const mockedGetRecents = getRecentGalleryCaptionLocales as jest.MockedFunction<typeof getRecentGalleryCaptionLocales>;
const mockedRecordRecent = recordGalleryCaptionLocaleRecent as jest.MockedFunction<typeof recordGalleryCaptionLocaleRecent>;

describe('GalleryImportCaptionSettingsScreen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockedFamily.mockReturnValue({ familyId: 'family-1', role: 'owner' } as never);
    mockedCaptionSettings.mockReturnValue({
      settings: { language: 'en-GB', instructions: '', updatedAt: null },
      save: jest.fn().mockResolvedValue({ language: 'en-GB', instructions: '', updatedAt: null }),
    } as never);
    mockedGetRecents.mockResolvedValue([]);
    mockedRecordRecent.mockResolvedValue([]);
  });

  afterEach(() => jest.useRealTimers());

  it('never renders an em-dash or double-hyphen anywhere in the screen, including the picker sheet and its search placeholder', async () => {
    const screen = render(<GalleryImportCaptionSettingsScreen />);
    await act(async () => { await Promise.resolve(); });

    const collectRenderedText = (node: unknown, out: string[] = []): string[] => {
      if (node == null) return out;
      if (typeof node === 'string') { out.push(node); return out; }
      if (Array.isArray(node)) { node.forEach((child) => collectRenderedText(child, out)); return out; }
      if (typeof node === 'object' && node !== null && 'children' in node) {
        collectRenderedText((node as { children?: unknown }).children, out);
      }
      return out;
    };

    let visibleText = collectRenderedText(screen.toJSON()).join(' ');
    expect(visibleText).not.toContain('—');
    expect(visibleText).not.toContain('--');

    fireEvent.press(screen.getByTestId('gallery-caption-language-row'));
    expect(screen.getByTestId('gallery-caption-language-picker')).toBeTruthy();
    visibleText = collectRenderedText(screen.toJSON()).join(' ');
    expect(visibleText).not.toContain('—');
    expect(visibleText).not.toContain('--');

    // Placeholder text is a prop, not a rendered text child, so the sweep
    // above can't see it -- check it directly.
    const searchPlaceholder = screen.getByTestId('gallery-caption-language-search').props.placeholder as string;
    expect(searchPlaceholder).not.toContain('—');
    expect(searchPlaceholder).not.toContain('--');
  });

  it('shows the selected language as a human-readable name, never a bare code', async () => {
    const screen = render(<GalleryImportCaptionSettingsScreen />);
    await act(async () => { await Promise.resolve(); });
    // The human-readable label is the prominent text; the raw tag may still
    // appear as a small secondary detail (design: label bold, tag muted/mono
    // underneath) but must never stand alone as the row's only identifier.
    expect(screen.getByText('English (United Kingdom)')).toBeTruthy();
  });

  it('opens a searchable picker and lets search find a language by native name, country, or code', async () => {
    const screen = render(<GalleryImportCaptionSettingsScreen />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.press(screen.getByTestId('gallery-caption-language-row'));
    expect(screen.getByTestId('gallery-caption-language-picker')).toBeTruthy();

    fireEvent.changeText(screen.getByTestId('gallery-caption-language-search'), 'pt-BR');
    expect(screen.getByTestId('gallery-caption-language-pt-BR')).toBeTruthy();
    expect(screen.getByText('português (Brasil)')).toBeTruthy();

    fireEvent.press(screen.getByTestId('gallery-caption-language-pt-BR'));
    // Picking a language closes the sheet and marks the change dirty.
    expect(screen.queryByTestId('gallery-caption-language-picker')).toBeNull();
    await act(async () => { jest.advanceTimersByTime(500); });
    const save = mockedCaptionSettings().save as jest.Mock;
    expect(save).toHaveBeenCalledWith({ language: 'pt-BR', instructions: '' });
    expect(screen.getByText('Portuguese (Brazil)')).toBeTruthy();
  });

  it('shows the real curated count, not the old 241-entry full-registry count', async () => {
    const screen = render(<GalleryImportCaptionSettingsScreen />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.press(screen.getByTestId('gallery-caption-language-row'));
    expect(
      screen.getByText(`${curatedGalleryCaptionLocaleTags.length} languages and regional variants`),
    ).toBeTruthy();
    expect(screen.queryByText(/^241 /)).toBeNull();
  });

  it('records the previously active language as a recent when switching', async () => {
    const screen = render(<GalleryImportCaptionSettingsScreen />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.press(screen.getByTestId('gallery-caption-language-row'));
    fireEvent.changeText(screen.getByTestId('gallery-caption-language-search'), 'es-MX');
    fireEvent.press(screen.getByTestId('gallery-caption-language-es-MX'));
    expect(mockedRecordRecent).toHaveBeenCalledWith('en-GB', 'es-MX');
    await act(async () => { await Promise.resolve(); });
  });

  it('shows a live counter for the instructions field and caps it at 500 characters', async () => {
    const screen = render(<GalleryImportCaptionSettingsScreen />);
    await act(async () => { await Promise.resolve(); });
    const input = screen.getByTestId('gallery-caption-instructions');
    fireEvent.changeText(input, 'We call the baby Bear.');
    expect(screen.getByTestId('gallery-caption-instructions-counter')).toHaveTextContent('22/500');

    const tooLong = 'x'.repeat(600);
    fireEvent.changeText(input, tooLong);
    expect(screen.getByTestId('gallery-caption-instructions-counter')).toHaveTextContent('500/500');
  });

  it('inserts an example pill into the instructions field', async () => {
    const screen = render(<GalleryImportCaptionSettingsScreen />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.press(screen.getByTestId('gallery-caption-example-No exclamation marks.'));
    expect(screen.getByTestId('gallery-caption-instructions').props.value).toBe('No exclamation marks.');
  });

  it('debounces a dirty owner edit once and shows visible saved/error feedback', async () => {
    const save = jest.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ language: 'en-GB', instructions: 'Try again.', updatedAt: null });
    mockedCaptionSettings.mockReturnValue({
      settings: { language: 'en-GB', instructions: '', updatedAt: null },
      save,
    } as never);
    const screen = render(<GalleryImportCaptionSettingsScreen />);
    await act(async () => { await Promise.resolve(); });
    const input = screen.getByTestId('gallery-caption-instructions');
    fireEvent.changeText(input, 'First try.');
    await act(async () => { jest.advanceTimersByTime(500); });
    expect(screen.getByText(/Could not save/)).toBeTruthy();
    fireEvent.changeText(input, 'Try again.');
    await act(async () => { jest.advanceTimersByTime(500); });
    expect(save).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Saved')).toBeTruthy();
  });

  it('never lets a non-owner open the editor, even navigating to the screen directly', async () => {
    mockedFamily.mockReturnValue({ familyId: 'family-1', role: 'viewer' } as never);
    mockedCaptionSettings.mockReturnValue({ settings: null, save: jest.fn() } as never);
    const screen = render(<GalleryImportCaptionSettingsScreen />);
    expect(screen.getByTestId('gallery-caption-settings-locked')).toBeTruthy();
    expect(screen.queryByTestId('gallery-caption-language-row')).toBeNull();
    expect(screen.queryByTestId('gallery-caption-instructions')).toBeNull();
    await act(async () => { await Promise.resolve(); });
  });

  it('never lets a non-owner manager open the editor either', async () => {
    mockedFamily.mockReturnValue({ familyId: 'family-1', role: 'manager' } as never);
    mockedCaptionSettings.mockReturnValue({ settings: null, save: jest.fn() } as never);
    const screen = render(<GalleryImportCaptionSettingsScreen />);
    expect(screen.getByTestId('gallery-caption-settings-locked')).toBeTruthy();
    expect(screen.queryByTestId('gallery-caption-instructions')).toBeNull();
    await act(async () => { await Promise.resolve(); });
  });

  describe('locale picker keyboard/sizing regression (device bug: sheet collapsed behind keyboard)', () => {
    it('wraps the sheet in a KeyboardAvoidingView with the platform-appropriate behavior', () => {
      expect(getGalleryCaptionLocalePickerKeyboardAvoidingBehavior('ios', false)).toBe('padding');
      expect(getGalleryCaptionLocalePickerKeyboardAvoidingBehavior('ios', true)).toBe('padding');
      // Android: unconditional 'height' fights the OS's own resize before any
      // keyboard event has fired -- only apply it once the keyboard is
      // actually up.
      expect(getGalleryCaptionLocalePickerKeyboardAvoidingBehavior('android', false)).toBeUndefined();
      expect(getGalleryCaptionLocalePickerKeyboardAvoidingBehavior('android', true)).toBe('height');
    });

    it('renders the sheet inside a KeyboardAvoidingView, not a plain View, so it repositions above the keyboard', async () => {
      const screen = render(<GalleryImportCaptionSettingsScreen />);
      await act(async () => { await Promise.resolve(); });
      fireEvent.press(screen.getByTestId('gallery-caption-language-row'));
      // Presence of the wrapper is the regression guard here -- the exact
      // `behavior` value per platform/keyboard-state is covered by the pure
      // helper test above; RNTL's host-node query does not surface
      // non-host props like `behavior` on `KeyboardAvoidingView` itself.
      expect(screen.getByTestId('gallery-caption-language-picker-keyboard-avoiding-view')).toBeTruthy();
    });

    it('gives the sheet a stable minHeight so it cannot shrink to nothing behind the keyboard', async () => {
      const screen = render(<GalleryImportCaptionSettingsScreen />);
      await act(async () => { await Promise.resolve(); });
      fireEvent.press(screen.getByTestId('gallery-caption-language-row'));
      const sheet = screen.getByTestId('gallery-caption-language-picker');
      const flatStyle = StyleSheet.flatten(sheet.props.style) as { minHeight?: unknown };
      expect(flatStyle.minHeight).toBeTruthy();
    });

    it('keeps the empty-search-results state visible inside the sheet\'s stable-height area, not collapsed away', async () => {
      const screen = render(<GalleryImportCaptionSettingsScreen />);
      await act(async () => { await Promise.resolve(); });
      fireEvent.press(screen.getByTestId('gallery-caption-language-row'));
      fireEvent.changeText(screen.getByTestId('gallery-caption-language-search'), 'zzzzznotalanguage');
      const emptyTitle = screen.getByText(/No language matches/);
      expect(emptyTitle).toBeTruthy();
      // The sheet itself is still present with its stable minHeight -- the
      // empty state renders inside it rather than the whole sheet
      // shrinking down around a couple of lines of text.
      const sheet = screen.getByTestId('gallery-caption-language-picker');
      const flatStyle = StyleSheet.flatten(sheet.props.style) as { minHeight?: unknown };
      expect(flatStyle.minHeight).toBeTruthy();
      expect(screen.queryByTestId('gallery-caption-language-options')).toBeNull();
    });
  });

  describe('locale picker sheet height metrics (round 2: sheet overexpanded with keyboard open)', () => {
    // Round 1 fixed the sheet collapsing behind the keyboard by giving it a
    // stable minHeight -- but that minHeight (and the maxHeight cap) were
    // screen-relative percentage strings that didn't know about the
    // keyboard, so once `KeyboardAvoidingView` freed up space by shrinking/
    // padding its container, the sheet grew to fill nearly the whole screen,
    // reaching the status bar and hiding the backdrop. This pure function is
    // the fix: real pixel min/max computed from actual available space, kept
    // free of RN/keyboard globals so it's testable without a real keyboard.
    it('matches the sheet\'s original no-keyboard sizing (88% cap, 68% floor) when the keyboard is closed', () => {
      const metrics = computeGalleryCaptionLocalePickerSheetMetrics(1000, 0, 47);
      expect(metrics.maxHeight).toBeCloseTo(880);
      expect(metrics.minHeight).toBeCloseTo(680);
    });

    it('caps maxHeight to the space actually available above the keyboard, not the no-keyboard 88%', () => {
      // A typical keyboard covering ~40% of a 1000pt window.
      const metrics = computeGalleryCaptionLocalePickerSheetMetrics(1000, 400, 47);
      expect(metrics.maxHeight).toBeLessThan(880); // strictly less than the no-keyboard cap
      // A visible band of backdrop -- at least the ~16% reserved top margin
      // -- must remain above the sheet, keyboard included.
      const spaceAboveSheetAndKeyboard = 1000 - metrics.maxHeight - 400;
      expect(spaceAboveSheetAndKeyboard).toBeGreaterThanOrEqual(1000 * 0.16 - 1);
    });

    it('never lets minHeight exceed maxHeight, however small the available space gets -- the actual round-2 bug', () => {
      for (const keyboardHeight of [0, 100, 300, 500, 700, 900, 1200]) {
        const metrics = computeGalleryCaptionLocalePickerSheetMetrics(1000, keyboardHeight, 47);
        expect(metrics.minHeight).toBeLessThanOrEqual(metrics.maxHeight);
        expect(metrics.maxHeight).toBeGreaterThanOrEqual(0);
        expect(metrics.minHeight).toBeGreaterThanOrEqual(0);
      }
    });

    it('still leaves the sheet visible above an enormous keyboard rather than going negative', () => {
      const metrics = computeGalleryCaptionLocalePickerSheetMetrics(600, 900, 47);
      expect(metrics.maxHeight).toBeGreaterThanOrEqual(0);
      expect(metrics.minHeight).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(metrics.maxHeight)).toBe(true);
    });

    it('grows the cap back toward the no-keyboard size as the keyboard height shrinks toward zero', () => {
      const closed = computeGalleryCaptionLocalePickerSheetMetrics(1000, 0, 47);
      const smallKeyboard = computeGalleryCaptionLocalePickerSheetMetrics(1000, 50, 47);
      const bigKeyboard = computeGalleryCaptionLocalePickerSheetMetrics(1000, 400, 47);
      expect(bigKeyboard.maxHeight).toBeLessThanOrEqual(smallKeyboard.maxHeight);
      expect(smallKeyboard.maxHeight).toBeLessThanOrEqual(closed.maxHeight);
    });

    it('end-to-end: caps the rendered sheet height once a real keyboardDidShow event fires, and restores it on hide', async () => {
      const keyboardListeners: Record<string, (event: { endCoordinates: { height: number } }) => void> = {};
      const addListenerSpy = jest.spyOn(Keyboard, 'addListener').mockImplementation((event, listener) => {
        keyboardListeners[event as string] = listener as never;
        return { remove: jest.fn() } as never;
      });
      const windowHeight = Dimensions.get('window').height;

      const screen = render(<GalleryImportCaptionSettingsScreen />);
      await act(async () => { await Promise.resolve(); });
      fireEvent.press(screen.getByTestId('gallery-caption-language-row'));
      const sheet = screen.getByTestId('gallery-caption-language-picker');
      const closedMaxHeight = (StyleSheet.flatten(sheet.props.style) as { maxHeight?: number }).maxHeight ?? 0;
      expect(closedMaxHeight).toBeGreaterThan(0);

      const keyboardHeight = Math.round(windowHeight * 0.4);
      act(() => keyboardListeners.keyboardDidShow({ endCoordinates: { height: keyboardHeight } }));
      const openMaxHeight = (StyleSheet.flatten(sheet.props.style) as { maxHeight?: number }).maxHeight ?? 0;
      // The core round-2 assertion: with the keyboard open, the sheet must
      // NOT extend to the top of the screen -- a visible band of backdrop
      // (the reserved top margin) has to remain above it.
      expect(openMaxHeight).toBeLessThan(closedMaxHeight);
      expect(windowHeight - openMaxHeight - keyboardHeight).toBeGreaterThan(0);

      act(() => keyboardListeners.keyboardDidHide());
      const restoredMaxHeight = (StyleSheet.flatten(sheet.props.style) as { maxHeight?: number }).maxHeight ?? 0;
      expect(restoredMaxHeight).toBeCloseTo(closedMaxHeight);

      addListenerSpy.mockRestore();
    });
  });
});
