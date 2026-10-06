import { assert, assertEquals } from 'jsr:@std/assert@1';
import { buildVoiceCheckRequestBody, isVoiceVerified, parseVoiceCheck } from './year-film-voice.ts';

Deno.test('parseVoiceCheck reads strict or fenced JSON and rejects anything else', () => {
  assertEquals(parseVoiceCheck('{"child_voice":"clear","adult_dominant":false,"starts_cleanly":true,"heard":"toddler singing"}'), {
    childVoice: 'clear',
    adultDominant: false,
    startsCleanly: true,
    heard: 'toddler singing',
  });
  assertEquals(parseVoiceCheck('```json\n{"child_voice":"faint","adult_dominant":true,"starts_cleanly":true}\n```')!.childVoice, 'faint');
  assertEquals(parseVoiceCheck('{"child_voice":"clear","adult_dominant":false}'), null);
  assertEquals(parseVoiceCheck('{"child_voice":"loud","adult_dominant":false}'), null);
  assertEquals(parseVoiceCheck('{"child_voice":"clear"}'), null);
  assertEquals(parseVoiceCheck('I hear a child'), null);
  assertEquals(parseVoiceCheck(null), null);
});

Deno.test('only a clear child voice without a dominant adult carries the sound scene', () => {
  assert(isVoiceVerified({ childVoice: 'clear', adultDominant: false, startsCleanly: true, heard: '' }));
  assert(!isVoiceVerified({ childVoice: 'clear', adultDominant: true, startsCleanly: true, heard: '' }));
  assert(!isVoiceVerified({ childVoice: 'faint', adultDominant: false, startsCleanly: true, heard: '' }));
  assert(!isVoiceVerified({ childVoice: 'clear', adultDominant: false, startsCleanly: false, heard: 'cough, then singing' }));
  assert(!isVoiceVerified(null));
});

Deno.test('request carries the audio as wav input with text-only output', () => {
  const body = buildVoiceCheckRequestBody('UklGRg==', 'Lucía') as { modalities: string[]; messages: { content: { type: string }[] }[] };
  assertEquals(body.modalities, ['text']);
  assertEquals(body.messages[0].content.map((c) => c.type), ['text', 'input_audio']);
});
