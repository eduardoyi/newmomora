import {
  createMemoryComment,
  deleteMemoryComment,
  fetchMemoryComments,
  fetchMemoryReactions,
  isValidReaction,
  setMemoryLike,
  setMemoryReaction,
  validateCommentContent,
} from './engagement';

import { supabase } from '@/lib/supabase';

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getUser: jest.fn() },
    from: jest.fn(),
    rpc: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

function createBuilder(result: { data: unknown; error: unknown }) {
  const builder: Record<string, jest.Mock> & { then?: (resolve: (value: unknown) => void) => void } = {};
  for (const method of ['select', 'insert', 'delete', 'eq', 'order']) {
    builder[method] = jest.fn(() => builder);
  }
  builder.single = jest.fn(async () => result);
  builder.then = (resolve) => resolve(result);
  return builder;
}

describe('memory engagement service', () => {
  beforeEach(() => jest.clearAllMocks());

  it('validates empty and oversized comments', () => {
    expect(validateCommentContent('   ')).toBe('Comment cannot be empty');
    expect(validateCommentContent('a'.repeat(1001))).toContain('1,000');
    expect(validateCommentContent('A lovely memory')).toBeNull();
  });

  it('maps the atomic set-like RPC response', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValue({
      data: [{ liked: true, changed: true, like_count: '4' }],
      error: null,
    });

    const result = await setMemoryLike('memory-1', true);

    expect(supabase.rpc).toHaveBeenCalledWith('set_memory_like', {
      target_memory_id: 'memory-1',
      should_like: true,
    });
    expect(result.data).toEqual({ liked: true, changed: true, likeCount: 4 });
  });

  it('validates reactions like the DB constraint', () => {
    expect(isValidReaction('❤️')).toBe(true);
    expect(isValidReaction('👨‍👩‍👧‍👦')).toBe(true);
    expect(isValidReaction('')).toBe(false);
    expect(isValidReaction('   ')).toBe(false);
    expect(isValidReaction('a b')).toBe(false);
    expect(isValidReaction(' ❤️')).toBe(false);
    expect(isValidReaction('a\nb')).toBe(false);
    expect(isValidReaction('a'.repeat(17))).toBe(false);
    expect(isValidReaction('a'.repeat(16))).toBe(true);
  });

  it('maps the set-reaction RPC response', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValue({
      data: [{ my_reaction: '😂', changed: true, inserted: true, like_count: '4', top_reactions: ['😂', '❤️'] }],
      error: null,
    });

    const result = await setMemoryReaction('memory-1', '😂');

    expect(supabase.rpc).toHaveBeenCalledWith('set_memory_reaction', {
      target_memory_id: 'memory-1',
      reaction: '😂',
    });
    expect(result.data).toEqual({
      reaction: '😂',
      changed: true,
      inserted: true,
      likeCount: 4,
      topReactions: ['😂', '❤️'],
    });
  });

  it('sends null to remove a reaction and tolerates a missing top_reactions', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValue({
      data: [{ my_reaction: null, changed: true, inserted: false, like_count: 0 }],
      error: null,
    });

    const result = await setMemoryReaction('memory-1', null);

    expect(supabase.rpc).toHaveBeenCalledWith('set_memory_reaction', {
      target_memory_id: 'memory-1',
      reaction: null,
    });
    expect(result.data).toEqual({
      reaction: null,
      changed: true,
      inserted: false,
      likeCount: 0,
      topReactions: [],
    });
  });

  it('rejects invalid reactions without calling the RPC and surfaces RPC errors', async () => {
    const invalid = await setMemoryReaction('memory-1', 'a b');
    expect(invalid.error?.code).toBe('validation_error');
    expect(supabase.rpc).not.toHaveBeenCalled();

    (supabase.rpc as jest.Mock).mockResolvedValue({ data: null, error: { message: 'nope', code: '42501' } });
    const failed = await setMemoryReaction('memory-1', '❤️');
    expect(failed.error).toEqual({ message: 'nope', code: '42501' });
  });

  it('lists who reacted, newest first', async () => {
    const builder = createBuilder({
      data: [{ user_id: 'user-1', emoji: '😂', updated_at: '2026-10-11T12:00:00Z' }],
      error: null,
    });
    (supabase.from as jest.Mock).mockReturnValue(builder);

    const result = await fetchMemoryReactions('memory-1');

    expect(supabase.from).toHaveBeenCalledWith('memory_likes');
    expect(builder.select).toHaveBeenCalledWith('user_id, emoji, updated_at');
    expect(builder.eq).toHaveBeenCalledWith('memory_id', 'memory-1');
    expect(builder.order).toHaveBeenCalledWith('updated_at', { ascending: false });
    expect(result.data).toEqual([
      { userId: 'user-1', emoji: '😂', updatedAt: '2026-10-11T12:00:00Z' },
    ]);
  });

  it('fetches comments chronologically for one memory', async () => {
    const builder = createBuilder({ data: [{ id: 'comment-1' }], error: null });
    (supabase.from as jest.Mock).mockReturnValue(builder);

    const result = await fetchMemoryComments('memory-1');

    expect(supabase.from).toHaveBeenCalledWith('memory_comments');
    expect(builder.eq).toHaveBeenCalledWith('memory_id', 'memory-1');
    expect(builder.order).toHaveBeenCalledWith('created_at', { ascending: true });
    expect(result.data).toEqual([{ id: 'comment-1' }]);
  });

  it('trims and attributes a new comment to the signed-in account', async () => {
    (supabase.auth.getUser as jest.Mock).mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    });
    const builder = createBuilder({
      data: { id: 'comment-1', memory_id: 'memory-1', user_id: 'user-1', content: 'Hello' },
      error: null,
    });
    (supabase.from as jest.Mock).mockReturnValue(builder);

    const result = await createMemoryComment('memory-1', '  Hello  ');

    expect(builder.insert).toHaveBeenCalledWith({
      memory_id: 'memory-1',
      user_id: 'user-1',
      content: 'Hello',
    });
    expect(result.error).toBeNull();
  });

  it('deletes a comment by id and leaves authorization to RLS', async () => {
    const builder = createBuilder({ data: null, error: null });
    (supabase.from as jest.Mock).mockReturnValue(builder);

    expect((await deleteMemoryComment('comment-1')).error).toBeNull();
    expect(builder.delete).toHaveBeenCalled();
    expect(builder.eq).toHaveBeenCalledWith('id', 'comment-1');
  });
});
