import { onlineManager } from '@tanstack/react-query';

import { describeEditSaveError, summarizeMediaSaveProgress } from '@/utils/media-save-progress';

describe('summarizeMediaSaveProgress', () => {
  it('returns null when nothing new is uploading', () => {
    expect(summarizeMediaSaveProgress([])).toBeNull();
  });

  it('narrates a single video compress then upload with a weighted overall bar', () => {
    expect(summarizeMediaSaveProgress([{ isVideo: true, phase: 'preparing', fraction: 0.5 }])).toEqual({
      label: 'Compressing video… 20%',
      fraction: 0.2,
    });
    expect(summarizeMediaSaveProgress([{ isVideo: true, phase: 'uploading', fraction: 0.5 }])).toEqual({
      label: 'Uploading video… 70%',
      fraction: 0.7,
    });
  });

  it('counts position across several new items', () => {
    const summary = summarizeMediaSaveProgress([
      { isVideo: false, phase: 'done', fraction: 1 },
      { isVideo: true, phase: 'uploading', fraction: 0 },
    ]);
    expect(summary?.label).toBe('Uploading 2 of 2… 70%');
  });

  it('switches to "Saving…" once every upload is done', () => {
    expect(
      summarizeMediaSaveProgress([
        { isVideo: false, phase: 'done', fraction: 1 },
        { isVideo: true, phase: 'done', fraction: 1 },
      ]),
    ).toEqual({ label: 'Saving…', fraction: 1 });
  });
});

describe('describeEditSaveError', () => {
  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it('names the failed item using its 1-based grid position', () => {
    expect(
      describeEditSaveError(new Error('Media upload failed'), { position: 2, contentType: 'video/mp4' }),
    ).toBe("Couldn't upload video 2. Media upload failed.");
  });

  it('swaps raw network errors for a connection hint', () => {
    expect(
      describeEditSaveError(new TypeError('Network request failed'), { position: 1, contentType: 'image/jpeg' }),
    ).toBe("Couldn't upload photo 1. Check your connection and try again.");
    expect(describeEditSaveError(new TypeError('Network request failed'))).toBe(
      "Couldn't save your changes. Check your connection and try again.",
    );
  });

  it('passes other errors through as-is', () => {
    expect(describeEditSaveError(new Error('Media memories need at least one photo or video.'))).toBe(
      'Media memories need at least one photo or video.',
    );
  });
});
