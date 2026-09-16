import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { stageWidgetImage, WIDGET_MAX_SOURCE_DOWNLOAD_BYTES } from './widget-cache';

function fixture() {
  const download = jest.fn(async () => ({ status: 200 }));
  const pause = jest.fn(async () => undefined);
  const remove = jest.fn(async () => undefined);
  const resize = jest.fn(async () => ({ uri: 'file:///resized.jpg', width: 512, height: 256 }));
  const fs = {
    cacheDirectory: 'file:///cache/',
    makeDirectoryAsync: jest.fn(async () => undefined),
    createDownloadResumable: jest.fn(() => ({ downloadAsync: download, pauseAsync: pause })),
    getInfoAsync: jest.fn(async () => ({ exists: true, size: 512 })),
    deleteAsync: remove,
    moveAsync: jest.fn(async () => undefined),
  };
  return {
    fs, download, pause, remove, resize,
    options: {
      fileSystem: fs as unknown as typeof FileSystem,
      imageManipulator: { manipulateAsync: resize, SaveFormat: { JPEG: 'jpeg' } } as unknown as typeof ImageManipulator,
      getImageSize: async () => ({ width: 2048, height: 1024 }),
    },
  };
}

const input = { filename: 'memory.jpg', url: 'https://example.test/synthetic' };

it('resizes large source artwork to a bounded preview before publication', async () => {
  const f = fixture();
  const staged = await stageWidgetImage('generation-a', input, f.options);
  expect(f.resize).toHaveBeenCalledWith(expect.any(String), [{ resize: { width: 512 } }], { compress: 0.78, format: 'jpeg' });
  expect(staged).toMatchObject({ filename: 'memory.jpg', sizeBytes: 512 });
});

it('rejects non-success image responses and removes their local files', async () => {
  const f = fixture();
  f.download.mockResolvedValue({ status: 403 });
  await expect(stageWidgetImage('generation-a', input, f.options)).rejects.toThrow('403');
  expect(f.remove).toHaveBeenCalledWith(expect.stringContaining('memory.jpg'), { idempotent: true });
  expect(f.resize).not.toHaveBeenCalled();
});

it('rejects oversized sources before decoding', async () => {
  const f = fixture();
  f.fs.getInfoAsync.mockResolvedValue({ exists: true, size: WIDGET_MAX_SOURCE_DOWNLOAD_BYTES + 1 });
  await expect(stageWidgetImage('generation-a', input, f.options)).rejects.toThrow('download limit');
  expect(f.resize).not.toHaveBeenCalled();
  expect(f.remove).toHaveBeenCalled();
});

it('waits for a cancelled native download to settle, then removes its late file', async () => {
  const f = fixture();
  const abort = new AbortController();
  let finish!: (value: { status: number }) => void;
  f.download.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const staged = stageWidgetImage('generation-a', input, { ...f.options, signal: abort.signal });
  await Promise.resolve();
  abort.abort();
  finish({ status: 200 });
  await expect(staged).rejects.toThrow('cancelled');
  expect(f.pause).toHaveBeenCalled();
  expect(f.remove).toHaveBeenCalled();
  expect(f.resize).not.toHaveBeenCalled();
});

it('rejects unsafe filenames before starting a download', async () => {
  const f = fixture();
  await expect(stageWidgetImage('generation-a', { ...input, filename: '../secret.jpg' }, f.options)).rejects.toThrow();
  expect(f.download).not.toHaveBeenCalled();
});
