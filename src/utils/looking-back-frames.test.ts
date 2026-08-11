import { LOOKING_BACK_DWELL, frameMediaKeys, lookingBackCover, lookingBackCoverMemory, textDurationMs, videoDurationMs, wordCount } from './looking-back-frames';

describe('Looking Back frame dwell rules', () => {
  it('uses the approved text boundary and long-text calculation', () => {
    expect(wordCount('one two three')).toBe(3);
    expect(textDurationMs(Array.from({ length: 45 }, () => 'word').join(' '))).toBe(LOOKING_BACK_DWELL.textShort);
    expect(textDurationMs(Array.from({ length: 46 }, () => 'word').join(' '))).toBe(16000);
    expect(textDurationMs(Array.from({ length: 100 }, () => 'word').join(' '))).toBe(16000);
  });

  it('clamps video dwell to the 3.5–9 second viewing window', () => {
    expect(videoDurationMs(1000)).toBe(3500);
    expect(videoDurationMs(null)).toBe(6000);
    expect(videoDurationMs(14000)).toBe(9000);
  });

  it('never uses a report-hidden illustration as the package cover', () => {
    const hiddenIllustration = { id: 'hidden', memory_type: 'text_illustration', illustration_status: 'ready', illustration_key: 'hidden-key', mediaAssets: [], isIllustrationHidden: true } as any;
    const photo = { id: 'photo', memory_type: 'media', illustration_status: 'failed', illustration_key: null, mediaAssets: [{ id: 'asset' }] } as any;
    expect(lookingBackCoverMemory([hiddenIllustration, photo])).toBe(photo);
  });

  it('skips an unpostered first video for a later displayable photo', () => {
    const legacyVideo = { id: 'video-memory', memory_type: 'media', mediaAssets: [{ id: 'video', content_type: 'video/mp4', object_key: 'raw.mp4', preview_object_key: null, position: 0 }] } as any;
    const photo = { id: 'photo-memory', memory_type: 'media', mediaAssets: [{ id: 'photo', content_type: 'image/jpeg', object_key: 'photo.jpg', preview_object_key: null, position: 0 }] } as any;
    expect(lookingBackCover([legacyVideo, photo])).toEqual(expect.objectContaining({ memory: photo, mediaAsset: photo.mediaAssets[0] }));
  });

  it('falls back to a text plate rather than passing a legacy raw video to expo-image', () => {
    const legacyVideo = { id: 'video-memory', memory_type: 'media', mediaAssets: [{ id: 'video', content_type: 'video/quicktime', object_key: 'raw.mov', preview_object_key: null, position: 0 }] } as any;
    expect(lookingBackCover([legacyVideo])).toEqual({ memory: legacyVideo });
  });

  it('keeps StoryFrame query groupings and image-safe warm keys aligned by frame kind', () => {
    const illustration = {
      kind: 'illustration',
      memory: { illustration_key: 'illustration-key', isIllustrationHidden: false },
    } as any;
    const photoWithPreview = {
      kind: 'photo',
      asset: { object_key: 'photo-original', preview_object_key: 'photo-preview' },
    } as any;
    const photoWithoutPreview = {
      kind: 'photo',
      asset: { object_key: 'photo-original', preview_object_key: null },
    } as any;
    const video = {
      kind: 'video',
      asset: { object_key: 'video-original', preview_object_key: 'video-poster' },
    } as any;
    const videoWithoutPoster = {
      kind: 'video',
      asset: { object_key: 'video-original', preview_object_key: null },
    } as any;

    expect(frameMediaKeys(illustration)).toEqual({
      queryKeys: ['illustration-key'],
      warmKeys: ['illustration-key'],
    });
    expect(frameMediaKeys(photoWithPreview)).toEqual({
      queryKeys: ['photo-original', 'photo-preview'],
      warmKeys: ['photo-preview'],
    });
    expect(frameMediaKeys(photoWithoutPreview)).toEqual({
      queryKeys: ['photo-original'],
      warmKeys: ['photo-original'],
    });
    expect(frameMediaKeys(video)).toEqual({
      queryKeys: ['video-original', 'video-poster'],
      warmKeys: ['video-poster'],
    });
    expect(frameMediaKeys(videoWithoutPoster)).toEqual({
      queryKeys: ['video-original'],
      warmKeys: [],
    });
    expect(frameMediaKeys({ kind: 'text-short' } as any)).toEqual({ queryKeys: [], warmKeys: [] });
  });

  it('does not sign or warm a hidden illustration frame', () => {
    expect(frameMediaKeys({
      kind: 'illustration',
      memory: { illustration_key: 'reported-illustration', isIllustrationHidden: true },
    } as any)).toEqual({ queryKeys: [], warmKeys: [] });
  });
});
