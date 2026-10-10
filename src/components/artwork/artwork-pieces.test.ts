import { artworkLabelContent, artworkPieces } from '@/components/artwork/artwork-pieces';
import { pickFrameStyle } from '@/components/artwork/frame-style';
import type { MemoryMediaAsset, MemoryWithTags } from '@/services/memories';

const asset = (id: string, overrides: Partial<MemoryMediaAsset> = {}): MemoryMediaAsset =>
  ({
    id,
    memory_id: 'memory-1',
    object_key: `u/${id}.jpg`,
    preview_object_key: `u/${id}-preview.jpg`,
    content_type: 'image/jpeg',
    aspect_ratio: 0.75,
    position: 0,
    ...overrides,
  }) as MemoryMediaAsset;

describe('artworkPieces', () => {
  it('derives the frame from each asset id and prefers the preview key', () => {
    const pieces = artworkPieces('memory-1', [asset('a1'), asset('a2', { preview_object_key: null })], null);
    expect(pieces).toHaveLength(2);
    expect(pieces[0]).toMatchObject({ id: 'a1', displayKey: 'u/a1-preview.jpg', ratio: 0.75, ...pickFrameStyle('a1') });
    expect(pieces[1].displayKey).toBe('u/a2.jpg');
  });

  it('falls back to the memory id and legacy key when there is no asset row', () => {
    const [piece] = artworkPieces('memory-9', [], 'u/legacy.jpg');
    expect(piece).toMatchObject({ id: 'memory-9', displayKey: 'u/legacy.jpg', ...pickFrameStyle('memory-9') });
  });
});

describe('artworkLabelContent', () => {
  const memory = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 'memory-1',
      content: 'A dragon for Daddy',
      memory_date: '2026-10-10',
      link_previews: {},
      taggedMembers: [{ id: 'm1', name: 'Mara', date_of_birth: '2024-10-01' }],
      ...overrides,
    }) as unknown as MemoryWithTags;

  it('quotes the caption and appends the artist and age', () => {
    expect(artworkLabelContent(memory())).toEqual({
      title: '“A dragon for Daddy”',
      artist: 'Mara, 2 years',
    });
  });

  it('omits the title when the caption is empty', () => {
    expect(artworkLabelContent(memory({ content: '   ' })).title).toBeNull();
    expect(artworkLabelContent(memory({ content: null })).title).toBeNull();
  });

  it('omits the artist when nobody is tagged', () => {
    expect(artworkLabelContent(memory({ taggedMembers: [] })).artist).toBeNull();
  });

  it('shows just the name when the member has no birthday or is an adult', () => {
    expect(
      artworkLabelContent(memory({ taggedMembers: [{ id: 'm1', name: 'Mara', date_of_birth: null }] })).artist,
    ).toBe('Mara');
    expect(
      artworkLabelContent(memory({ taggedMembers: [{ id: 'm1', name: 'Dad', date_of_birth: '1985-03-02' }] })).artist,
    ).toBe('Dad');
  });

  it('uses the leading unit only: years without months, then months, then newborn', () => {
    const artistFor = (dob: string) =>
      artworkLabelContent(memory({ taggedMembers: [{ id: 'm1', name: 'Theo', date_of_birth: dob }] })).artist;
    expect(artistFor('2024-06-01')).toBe('Theo, 2 years'); // 2 years, 4 months -> "2 years"
    expect(artistFor('2025-10-01')).toBe('Theo, 1 year');
    expect(artistFor('2021-03-01')).toBe('Theo, 5 years');
    expect(artistFor('2026-03-01')).toBe('Theo, 7 months');
    expect(artistFor('2026-09-20')).toBe('Theo, newborn');
  });

  it('uses only the first tagged member', () => {
    const tagged = [
      { id: 'm1', name: 'Mara', date_of_birth: '2024-10-01' },
      { id: 'm2', name: 'Theo', date_of_birth: '2021-01-01' },
    ];
    expect(artworkLabelContent(memory({ taggedMembers: tagged })).artist).toBe('Mara, 2 years');
  });

  it('truncates a very long caption', () => {
    const { title } = artworkLabelContent(memory({ content: 'x'.repeat(200) }));
    expect(title!.length).toBeLessThan(90);
    expect(title).toContain('…');
  });
});
