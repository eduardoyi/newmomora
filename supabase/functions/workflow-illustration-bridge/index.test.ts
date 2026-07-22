import { assertEquals } from 'jsr:@std/assert@1';
import {
  classifyNonceInsertError,
  getReconcileAction,
  isSignedWorkflowRequest,
  mapPublishOutcome,
  toWorkflowJobInput,
} from './index.ts';

async function sign(timestamp: string, nonce: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('bridge-test-secret'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${timestamp}.${nonce}.${body}`),
  ));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

Deno.test('workflow bridge HMAC binds the nonce as well as timestamp and body', async () => {
  const previous = Deno.env.get('CLOUDFLARE_ILLUSTRATION_BRIDGE_SECRET');
  Deno.env.set('CLOUDFLARE_ILLUSTRATION_BRIDGE_SECRET', 'bridge-test-secret');
  try {
    const timestamp = String(Date.now());
    const nonce = '4e5c933a-3a75-4a23-9adc-82227afc10e9';
    const body = JSON.stringify({ operation: 'get_input', jobId: '22222222-2222-4222-8222-222222222222' });
    const signature = await sign(timestamp, nonce, body);
    const valid = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'x-workflow-timestamp': timestamp,
        'x-workflow-nonce': nonce,
        'x-workflow-signature': signature,
      },
    });
    assertEquals(await isSignedWorkflowRequest(valid, body), true);
    const replayWithFreshNonce = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'x-workflow-timestamp': timestamp,
        'x-workflow-nonce': '4e5c933a-3a75-4a23-9adc-82227afc10ea',
        'x-workflow-signature': signature,
      },
    });
    assertEquals(await isSignedWorkflowRequest(replayWithFreshNonce, body), false);
  } finally {
    if (previous === undefined) Deno.env.delete('CLOUDFLARE_ILLUSTRATION_BRIDGE_SECRET');
    else Deno.env.set('CLOUDFLARE_ILLUSTRATION_BRIDGE_SECRET', previous);
  }
});

Deno.test('workflow bridge maps publication and reconciliation outcomes to the Worker contract', () => {
  assertEquals(mapPublishOutcome({ published: true, old_key: 'old.webp' }), {
    published: true, oldIllustrationKey: 'old.webp', deleteOutput: false,
  });
  assertEquals(mapPublishOutcome({ already_published: true, old_key: 'old.webp' }), {
    published: true, oldIllustrationKey: 'old.webp', deleteOutput: false,
  });
  assertEquals(mapPublishOutcome({ published: false }), {
    published: false, oldIllustrationKey: null, deleteOutput: true,
  });
  assertEquals(getReconcileAction({ status: 'running', outputKey: 'new.webp', expectedOutputKey: 'new.webp' }), 'republish');
  assertEquals(getReconcileAction({ status: 'succeeded', outputKey: 'new.webp', expectedOutputKey: 'new.webp' }), 'succeeded');
  assertEquals(getReconcileAction({ status: 'superseded', outputKey: 'new.webp', expectedOutputKey: 'new.webp' }), 'delete');
});

Deno.test('workflow bridge classifies nonce failures and nests get_input without prompt data', () => {
  assertEquals(classifyNonceInsertError(null), 'ok');
  assertEquals(classifyNonceInsertError({ code: '23505' }), 'replay');
  assertEquals(classifyNonceInsertError({ code: '08006' }), 'error');
  assertEquals(toWorkflowJobInput({
    id: '22222222-2222-4222-8222-222222222222',
    output_key: 'new.webp', old_illustration_key: 'old.webp', provider_deadline_at: '2026-07-21T12:05:00Z',
    style_description: 'storybook', safe_scene_description: 'safe scene', expression_style: 'tender',
    color_palette: 'rose', emotion: 'tender', memory_date: '2026-07-21', reference_candidates: [],
  }), {
    job: {
      jobId: '22222222-2222-4222-8222-222222222222', outputKey: 'new.webp', oldIllustrationKey: 'old.webp',
      providerDeadlineAt: '2026-07-21T12:05:00Z', styleDescription: 'storybook', safeSceneDescription: 'safe scene',
      expressionStyle: 'tender', colorPalette: 'rose', emotion: 'tender', memoryDate: '2026-07-21', referenceCandidates: [],
    },
  });
});
