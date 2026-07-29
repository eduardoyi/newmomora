import { assertEquals } from 'jsr:@std/assert@1';
import { buildAiUsageAlertHtml, handleRunAiUsageAlerts, safeAlertMetrics } from './index.ts';

Deno.test('AI usage alert output contains aggregate metadata only', () => {
  const html = buildAiUsageAlertHtml({ id: 'x', kind: 'fallback', family_id: 'family-id', payload: { imageCalls: 20, fallbackCalls: 5 } }, 'staging');
  assertEquals(html.includes('staging'), true);
  assertEquals(html.includes('family-id'), true);
  assertEquals(html.includes('imageCalls'), true);
});

Deno.test('AI usage alerts apply an exact metric allowlist for each alert kind', () => {
  assertEquals(safeAlertMetrics('request', {
    consumedRequests: 12, threshold: 10, monthlyCap: 20, estimatedCostUsd: 4.2,
  }), { consumedRequests: 12, threshold: 10, monthlyCap: 20 });
  assertEquals(safeAlertMetrics('spend', { estimatedCostUsd: 5, fallbackCalls: 4 }), { estimatedCostUsd: 5 });
  assertEquals(safeAlertMetrics('unpriced', {
    scope: 'global', threshold: 0.2, minCalls: 20, prompt: 'private text', scopeHint: 'untrusted',
  }), { scope: 'global', threshold: 0.2, minCalls: 20 });
  assertEquals(safeAlertMetrics('unknown', { total: 1 }), {});
});

Deno.test('AI usage alert renderer excludes untrusted content-like payload fields', () => {
  const html = buildAiUsageAlertHtml({
    id: 'x', kind: 'fallback', family_id: 'family-id',
    payload: { total_image_calls: 20, prompt: 'secret memory', transcript: 'child name', content: 'private', name: 'Ada' },
  }, 'staging');
  assertEquals(html.includes('secret memory'), false);
  assertEquals(html.includes('child name'), false);
  assertEquals(html.includes('Ada'), false);
});

Deno.test('AI usage alert cron rejects a missing secret', async () => {
  const previous = Deno.env.get('CRON_SECRET');
  Deno.env.delete('CRON_SECRET');
  try {
    const response = await handleRunAiUsageAlerts(new Request('http://localhost/run-ai-usage-alerts', { method: 'POST' }));
    assertEquals(response.status, 401);
  } finally {
    if (previous === undefined) Deno.env.delete('CRON_SECRET');
    else Deno.env.set('CRON_SECRET', previous);
  }
});
