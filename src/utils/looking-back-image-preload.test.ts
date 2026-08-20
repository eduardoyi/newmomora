import { Image } from 'expo-image';

import {
  preloadLookingBackImage,
  resetLookingBackImagePreloadForTests,
} from './looking-back-image-preload';

jest.mock('expo-image', () => ({
  Image: { loadAsync: jest.fn() },
}));

const mockedLoadAsync = Image.loadAsync as jest.MockedFunction<typeof Image.loadAsync>;

describe('preloadLookingBackImage', () => {
  beforeEach(() => {
    resetLookingBackImagePreloadForTests();
    jest.clearAllMocks();
  });

  it('shares one native load for concurrent callers with the exact same signed source', async () => {
    let resolveLoad: ((imageRef: { release: jest.Mock }) => void) | undefined;
    mockedLoadAsync.mockImplementation(() => new Promise((resolve) => {
      resolveLoad = resolve as (imageRef: { release: jest.Mock }) => void;
    }) as ReturnType<typeof Image.loadAsync>);
    const source = { uri: 'https://signed.example/photo', cacheKey: 'photo-key' };

    const warmupLoad = preloadLookingBackImage(source);
    const visibleLoad = preloadLookingBackImage({ ...source });

    expect(visibleLoad).toBe(warmupLoad);
    await Promise.resolve();
    expect(mockedLoadAsync).toHaveBeenCalledTimes(1);
    expect(mockedLoadAsync).toHaveBeenCalledWith(source);

    const release = jest.fn();
    resolveLoad?.({ release });
    await expect(warmupLoad).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not join a different signed URL just because the disk cache key matches', async () => {
    const resolvers: ((imageRef: { release: jest.Mock }) => void)[] = [];
    mockedLoadAsync.mockImplementation(() => new Promise((resolve) => {
      resolvers.push(resolve as (imageRef: { release: jest.Mock }) => void);
    }) as ReturnType<typeof Image.loadAsync>);
    const staleSource = { uri: 'https://signed.example/photo?old=1', cacheKey: 'photo-key' };
    const freshSource = { uri: 'https://signed.example/photo?fresh=1', cacheKey: 'photo-key' };

    const staleLoad = preloadLookingBackImage(staleSource);
    const freshLoad = preloadLookingBackImage(freshSource);

    await Promise.resolve();
    expect(freshLoad).not.toBe(staleLoad);
    expect(mockedLoadAsync).toHaveBeenCalledTimes(2);
    expect(mockedLoadAsync).toHaveBeenNthCalledWith(1, staleSource);
    expect(mockedLoadAsync).toHaveBeenNthCalledWith(2, freshSource);

    const staleRelease = jest.fn();
    const freshRelease = jest.fn();
    resolvers[0]?.({ release: staleRelease });
    resolvers[1]?.({ release: freshRelease });
    await expect(Promise.all([staleLoad, freshLoad])).resolves.toEqual([undefined, undefined]);
    expect(staleRelease).toHaveBeenCalledTimes(1);
    expect(freshRelease).toHaveBeenCalledTimes(1);
  });

  it('allows a later retry after a failed native load', async () => {
    mockedLoadAsync
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ release: jest.fn() } as never);
    const source = { uri: 'https://signed.example/photo', cacheKey: 'photo-key' };

    await expect(preloadLookingBackImage(source)).rejects.toThrow('offline');
    await expect(preloadLookingBackImage(source)).resolves.toBeUndefined();
    expect(mockedLoadAsync).toHaveBeenCalledTimes(2);
  });
});
