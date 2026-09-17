import { supabase } from '@/lib/supabase';
import { invokeEdgeFunction } from '@/services/ai';
import {
  countEligibleMemoriesForScope,
  createMemoryBook,
  dispatchMemoryBookGeneration,
  fetchExampleCoverAssetKey,
  fetchMemoryBooksForChild,
  memoryBookWebUrl,
} from '@/services/memory-books';

jest.mock('@/lib/supabase', () => ({
  supabase: { from: jest.fn() },
}));

jest.mock('@/services/ai', () => ({
  invokeEdgeFunction: jest.fn(),
}));

const mockedSupabase = supabase as jest.Mocked<typeof supabase>;
const mockedInvoke = invokeEdgeFunction as jest.MockedFunction<typeof invokeEdgeFunction>;

describe('memory-books service integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('fetchMemoryBooksForChild', () => {
    it('filters by family and child, newest first', async () => {
      const order = jest.fn().mockResolvedValue({ data: [{ id: 'book-1' }], error: null });
      const eqChild = jest.fn().mockReturnValue({ order });
      const eqFamily = jest.fn().mockReturnValue({ eq: eqChild });
      const select = jest.fn().mockReturnValue({ eq: eqFamily });
      mockedSupabase.from.mockReturnValue({ select } as never);

      const result = await fetchMemoryBooksForChild('family-1', 'child-1');

      expect(mockedSupabase.from).toHaveBeenCalledWith('memory_books');
      expect(eqFamily).toHaveBeenCalledWith('family_id', 'family-1');
      expect(eqChild).toHaveBeenCalledWith('child_id', 'child-1');
      expect(order).toHaveBeenCalledWith('created_at', { ascending: false });
      expect(result.data).toEqual([{ id: 'book-1' }]);
      expect(result.error).toBeNull();
    });

    it('maps a Supabase error', async () => {
      const order = jest.fn().mockResolvedValue({ data: null, error: { message: 'boom', code: '500' } });
      const eqChild = jest.fn().mockReturnValue({ order });
      const eqFamily = jest.fn().mockReturnValue({ eq: eqChild });
      const select = jest.fn().mockReturnValue({ eq: eqFamily });
      mockedSupabase.from.mockReturnValue({ select } as never);

      const result = await fetchMemoryBooksForChild('family-1', 'child-1');

      expect(result.data).toBeNull();
      expect(result.error).toEqual({ message: 'boom', code: '500' });
    });
  });

  describe('createMemoryBook', () => {
    it('inserts the exact just-queued shape the RLS with-check expects', async () => {
      const single = jest.fn().mockResolvedValue({ data: { id: 'book-1', status: 'queued' }, error: null });
      const select = jest.fn().mockReturnValue({ single });
      const insert = jest.fn().mockReturnValue({ select });
      mockedSupabase.from.mockReturnValue({ insert } as never);

      const result = await createMemoryBook({
        familyId: 'family-1',
        childId: 'child-1',
        requestedBy: 'user-1',
        scopeKind: 'age_year',
        scopeStartDate: '2023-06-01',
        scopeEndDate: '2024-05-31',
        scopeLabel: 'Year One',
      });

      expect(insert).toHaveBeenCalledWith({
        family_id: 'family-1',
        child_id: 'child-1',
        requested_by: 'user-1',
        scope_kind: 'age_year',
        scope_start_date: '2023-06-01',
        scope_end_date: '2024-05-31',
        scope_label: 'Year One',
        page_budget: 122,
      });
      expect(result.data).toEqual({ id: 'book-1', status: 'queued' });
      expect(result.error).toBeNull();
      expect(result.conflict).toBe(false);
    });

    it('sends null scope dates for an everything-scope insert', async () => {
      const single = jest.fn().mockResolvedValue({ data: { id: 'book-2' }, error: null });
      const select = jest.fn().mockReturnValue({ single });
      const insert = jest.fn().mockReturnValue({ select });
      mockedSupabase.from.mockReturnValue({ insert } as never);

      await createMemoryBook({
        familyId: 'family-1',
        childId: 'child-1',
        requestedBy: 'user-1',
        scopeKind: 'everything',
        scopeStartDate: null,
        scopeEndDate: null,
        scopeLabel: 'Everything',
      });

      expect(insert).toHaveBeenCalledWith(expect.objectContaining({
        scope_kind: 'everything',
        scope_start_date: null,
        scope_end_date: null,
      }));
    });

    it('flags a 23505 unique-index conflict distinctly so the caller can recover without an error wall', async () => {
      const single = jest.fn().mockResolvedValue({
        data: null,
        error: { message: 'duplicate key value violates unique constraint "memory_books_one_active_per_scope"', code: '23505' },
      });
      const select = jest.fn().mockReturnValue({ single });
      const insert = jest.fn().mockReturnValue({ select });
      mockedSupabase.from.mockReturnValue({ insert } as never);

      const result = await createMemoryBook({
        familyId: 'family-1',
        childId: 'child-1',
        requestedBy: 'user-1',
        scopeKind: 'age_year',
        scopeStartDate: '2023-06-01',
        scopeEndDate: '2024-05-31',
        scopeLabel: 'Year One',
      });

      expect(result.data).toBeNull();
      expect(result.conflict).toBe(true);
      expect(result.error?.code).toBe('23505');
    });

    it('does not flag a non-conflict error as a conflict', async () => {
      const single = jest.fn().mockResolvedValue({
        data: null,
        error: { message: 'permission denied', code: '42501' },
      });
      const select = jest.fn().mockReturnValue({ single });
      const insert = jest.fn().mockReturnValue({ select });
      mockedSupabase.from.mockReturnValue({ insert } as never);

      const result = await createMemoryBook({
        familyId: 'family-1',
        childId: 'child-1',
        requestedBy: 'user-1',
        scopeKind: 'calendar_year',
        scopeStartDate: '2024-01-01',
        scopeEndDate: '2024-12-31',
        scopeLabel: '2024',
      });

      expect(result.conflict).toBe(false);
      expect(result.error?.code).toBe('42501');
    });
  });

  describe('dispatchMemoryBookGeneration', () => {
    it('invokes generate-memory-book with the memory book id', async () => {
      mockedInvoke.mockResolvedValue({ data: { success: true, status: 'generating' }, error: null });

      const result = await dispatchMemoryBookGeneration('book-1');

      expect(mockedInvoke).toHaveBeenCalledWith('generate-memory-book', { memoryBookId: 'book-1' });
      expect(result.data).toEqual({ success: true, status: 'generating' });
    });

    it('surfaces a dispatch error without throwing', async () => {
      mockedInvoke.mockResolvedValue({ data: null, error: { message: 'Something went wrong. Please try again.', code: '500' } });

      const result = await dispatchMemoryBookGeneration('book-1');

      expect(result.data).toBeNull();
      expect(result.error?.code).toBe('500');
    });
  });

  describe('countEligibleMemoriesForScope', () => {
    function mockMemoriesQuery(rows: unknown[]) {
      const lt = jest.fn().mockResolvedValue({ data: rows, error: null });
      const gte = jest.fn().mockReturnValue({ lt });
      const eq = jest.fn().mockReturnValue({ gte });
      const select = jest.fn().mockReturnValue({ eq });
      mockedSupabase.from.mockReturnValue({ select } as never);
      return { select, eq, gte, lt };
    }

    it('counts memories tagged to the child or fully untagged', async () => {
      const rows = [
        { id: 'm1', memory_family_members: [] }, // untagged -- eligible
        { id: 'm2', memory_family_members: [{ family_member_id: 'child-1' }] }, // tagged to child -- eligible
        { id: 'm3', memory_family_members: [{ family_member_id: 'sibling-1' }] }, // tagged to someone else only -- excluded
        { id: 'm4', memory_family_members: [{ family_member_id: 'sibling-1' }, { family_member_id: 'child-1' }] }, // co-tagged -- eligible
      ];
      mockMemoriesQuery(rows);

      const result = await countEligibleMemoriesForScope('family-1', 'child-1', '2023-06-01', '2024-05-31');

      expect(result.data).toBe(3);
      expect(result.error).toBeNull();
    });

    it('queries the half-open window one day past the inclusive end date', async () => {
      const { select, eq, gte, lt } = mockMemoriesQuery([]);

      await countEligibleMemoriesForScope('family-1', 'child-1', '2023-06-01', '2024-05-31');

      expect(select).toHaveBeenCalledWith('id, memory_family_members(family_member_id)');
      expect(eq).toHaveBeenCalledWith('family_id', 'family-1');
      expect(gte).toHaveBeenCalledWith('memory_date', '2023-06-01');
      expect(lt).toHaveBeenCalledWith('memory_date', '2024-06-01');
    });

    it('applies no date filter for an everything scope', async () => {
      const lt = jest.fn();
      const gte = jest.fn();
      const eq = jest.fn().mockReturnValue({ gte, lt, then: undefined });
      const select = jest.fn().mockReturnValue({ eq });
      mockedSupabase.from.mockReturnValue({ select } as never);
      // With no start/end, the query never calls gte/lt -- it resolves the
      // `eq(...)` builder itself, so make it directly awaitable.
      (eq as jest.Mock).mockReturnValue(Promise.resolve({ data: [], error: null }));

      const result = await countEligibleMemoriesForScope('family-1', 'child-1', null, null);

      expect(gte).not.toHaveBeenCalled();
      expect(lt).not.toHaveBeenCalled();
      expect(result.data).toBe(0);
    });

    it('treats a null memory_family_members embed as untagged (eligible)', async () => {
      mockMemoriesQuery([{ id: 'm1', memory_family_members: null }]);

      const result = await countEligibleMemoriesForScope('family-1', 'child-1', '2023-06-01', '2024-05-31');

      expect(result.data).toBe(1);
    });

    it('maps a Supabase error', async () => {
      const lt = jest.fn().mockResolvedValue({ data: null, error: { message: 'boom', code: '500' } });
      const gte = jest.fn().mockReturnValue({ lt });
      const eq = jest.fn().mockReturnValue({ gte });
      const select = jest.fn().mockReturnValue({ eq });
      mockedSupabase.from.mockReturnValue({ select } as never);

      const result = await countEligibleMemoriesForScope('family-1', 'child-1', '2023-06-01', '2024-05-31');

      expect(result.data).toBeNull();
      expect(result.error).toEqual({ message: 'boom', code: '500' });
    });
  });

  describe('fetchExampleCoverAssetKey', () => {
    function mockExampleCoverQuery(rows: unknown[], error: { message: string; code?: string } | null = null) {
      const limit = jest.fn().mockResolvedValue({ data: error ? null : rows, error });
      const order = jest.fn().mockReturnValue({ limit });
      const like = jest.fn().mockReturnValue({ order });
      const eqMember = jest.fn().mockReturnValue({ like });
      const eqFamily = jest.fn().mockReturnValue({ eq: eqMember });
      const select = jest.fn().mockReturnValue({ eq: eqFamily });
      mockedSupabase.from.mockReturnValue({ select } as never);
      return { select, eqFamily, eqMember, like, order, limit };
    }

    it('queries the last 30 image memories tagged to this child, newest first', async () => {
      const { select, eqFamily, eqMember, like, order, limit } = mockExampleCoverQuery([
        { id: 'm1', memory_date: '2026-01-01', memory_media: [{ preview_object_key: 'preview-1', object_key: 'orig-1', content_type: 'image/jpeg' }] },
      ]);

      await fetchExampleCoverAssetKey('family-1', 'child-1');

      expect(mockedSupabase.from).toHaveBeenCalledWith('memories');
      expect(select).toHaveBeenCalledWith(
        'id, memory_date, memory_media!inner(preview_object_key, object_key, content_type), memory_family_members!inner(family_member_id)',
      );
      expect(eqFamily).toHaveBeenCalledWith('family_id', 'family-1');
      expect(eqMember).toHaveBeenCalledWith('memory_family_members.family_member_id', 'child-1');
      expect(like).toHaveBeenCalledWith('memory_media.content_type', 'image/%');
      expect(order).toHaveBeenCalledWith('memory_date', { ascending: false });
      expect(limit).toHaveBeenCalledWith(30);
    });

    it('prefers the preview key over the original object key', async () => {
      mockExampleCoverQuery([
        { id: 'm1', memory_date: '2026-01-01', memory_media: [{ preview_object_key: 'preview-1', object_key: 'orig-1', content_type: 'image/jpeg' }] },
      ]);

      const result = await fetchExampleCoverAssetKey('family-1', 'child-1');

      expect(result.data).toBe('preview-1');
      expect(result.error).toBeNull();
    });

    it('falls back to the original object key when there is no preview', async () => {
      mockExampleCoverQuery([
        { id: 'm1', memory_date: '2026-01-01', memory_media: [{ preview_object_key: null, object_key: 'orig-1', content_type: 'image/jpeg' }] },
      ]);

      const result = await fetchExampleCoverAssetKey('family-1', 'child-1');

      expect(result.data).toBe('orig-1');
    });

    it('returns null (never an error) when there are no eligible photos', async () => {
      mockExampleCoverQuery([]);

      const result = await fetchExampleCoverAssetKey('family-1', 'child-1');

      expect(result.data).toBeNull();
      expect(result.error).toBeNull();
    });

    it('maps a Supabase error', async () => {
      mockExampleCoverQuery([], { message: 'boom', code: '500' });

      const result = await fetchExampleCoverAssetKey('family-1', 'child-1');

      expect(result.data).toBeNull();
      expect(result.error).toEqual({ message: 'boom', code: '500' });
    });
  });

  describe('memoryBookWebUrl', () => {
    it('points at the shop.usemomora.com book viewer', () => {
      expect(memoryBookWebUrl('book-1')).toBe('https://shop.usemomora.com/b/book-1');
    });
  });
});
