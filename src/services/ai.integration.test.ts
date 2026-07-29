import { generateMemoryIllustration, processOnboardingVoiceMemory, processVoiceMemory } from '@/services/ai';
import { supabase } from '@/lib/supabase';

jest.mock('@/lib/supabase', () => ({
  supabase: {
    functions: {
      invoke: jest.fn(),
    },
  },
}));

describe('generateMemoryIllustration service contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('accepts the legacy synchronous success response', async () => {
    (supabase.functions.invoke as jest.Mock).mockResolvedValue({
      data: { success: true },
      error: null,
    });

    const result = await generateMemoryIllustration('memory-legacy', 'Tender', {
      requestIntent: 'initial',
    });

    expect(result).toEqual({ data: { success: true }, error: null });
    expect(supabase.functions.invoke).toHaveBeenCalledWith('generate-illustration', {
      body: {
        memoryId: 'memory-legacy',
        colorPalette: 'Tender',
        forceRegenerate: false,
        requestIntent: 'initial',
      },
    });
  });

  it('accepts the Cloudflare queued response without treating it as an error', async () => {
    (supabase.functions.invoke as jest.Mock).mockResolvedValue({
      data: { success: true, queued: true, jobId: 'job-1' },
      error: null,
    });

    const result = await generateMemoryIllustration('memory-queued', undefined, {
      requestIntent: 'recovery',
    });

    expect(result).toEqual({
      data: { success: true, queued: true, jobId: 'job-1' },
      error: null,
    });
    expect(supabase.functions.invoke).toHaveBeenCalledWith('generate-illustration', {
      body: {
        memoryId: 'memory-queued',
        colorPalette: undefined,
        forceRegenerate: false,
        requestIntent: 'recovery',
      },
    });
  });
});

describe('voice service contracts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps normal family voice capture family-scoped', async () => {
    (supabase.functions.invoke as jest.Mock).mockResolvedValue({
      data: { cleanedText: 'A memory', mentionedMemberIds: ['member-1'] }, error: null,
    });

    await processVoiceMemory('audio', [{ id: 'member-1', name: 'Maya' }], 'family-1');

    expect(supabase.functions.invoke).toHaveBeenCalledWith('process-voice-memory', {
      body: {
        audioBase64: 'audio',
        familyMembers: [{ id: 'member-1', name: 'Maya' }],
        familyId: 'family-1',
      },
    });
  });

  it('uses the separate onboarding contract without family or member identifiers', async () => {
    (supabase.functions.invoke as jest.Mock).mockResolvedValue({
      data: { cleanedText: 'A memory', mentionedMemberIds: [] }, error: null,
    });

    await processOnboardingVoiceMemory('audio', ['Maya', 'Leo']);

    expect(supabase.functions.invoke).toHaveBeenCalledWith('process-voice-memory', {
      body: { mode: 'onboarding', audioBase64: 'audio', nameHints: ['Maya', 'Leo'] },
    });
  });
});
