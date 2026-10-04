import { assert, assertEquals } from 'jsr:@std/assert@1';
import { buildFrameCheckRequestBody, burstFrameVerdict, isVerifiedSubject, parseFrameCheckResponse } from './year-film-vision.ts';

const IDS = new Map([['enzo', 'id-enzo'], ['mara', 'id-mara']]);

Deno.test('parseFrameCheckResponse maps names to ids and validates each frame', () => {
  const raw = JSON.stringify({
    frames: [
      { index: 0, main_subject: 'Enzo', children_visible: ['Enzo', 'Mara', 'Elena'], face_visible: true, expression: 'laughing', quality: 'good', unsafe: false, screen_capture: false },
      { index: 1, main_subject: 'group', children_visible: ['Enzo'], face_visible: true, expression: 'big_smile', quality: 'good', unsafe: false, screen_capture: false },
      { index: 2, main_subject: 'Enzo', face_visible: 'yes', expression: 'laughing', quality: 'good', unsafe: false, screen_capture: false }, // bad type
      { index: 3, main_subject: 'Enzo', children_visible: [], face_visible: true, expression: 'grinning', quality: 'good', unsafe: false, screen_capture: false }, // bad enum
      { index: 9, main_subject: 'Mara', children_visible: [], face_visible: true, expression: 'neutral', quality: 'good', unsafe: false, screen_capture: false }, // out of range
      { index: 0, main_subject: 'Mara', children_visible: [], face_visible: true, expression: 'neutral', quality: 'good', unsafe: false, screen_capture: false }, // duplicate
    ],
  });
  const checks = parseFrameCheckResponse(raw, 4, IDS);
  assertEquals([...checks.keys()], [0, 1]);
  assertEquals(checks.get(0), {
    mainSubject: 'id-enzo',
    childrenVisible: ['id-enzo', 'id-mara'],
    faceVisible: true,
    expression: 'laughing',
    quality: 'good',
    unsafe: false,
    screenCapture: false,
  });
  assertEquals(checks.get(1)!.mainSubject, 'group');
  assertEquals(parseFrameCheckResponse('nope', 2, IDS).size, 0);
});

Deno.test('isVerifiedSubject needs the child as clear, visible, sharp, safe subject', () => {
  const base = { mainSubject: 'id-enzo', childrenVisible: ['id-enzo'], faceVisible: true, expression: 'smiling' as const, quality: 'good' as const, unsafe: false, screenCapture: false };
  assert(isVerifiedSubject(base, 'id-enzo'));
  assert(!isVerifiedSubject(base, 'id-mara'));
  assert(!isVerifiedSubject({ ...base, mainSubject: 'group' }, 'id-enzo'));
  assert(!isVerifiedSubject({ ...base, faceVisible: false }, 'id-enzo'));
  assert(!isVerifiedSubject({ ...base, quality: 'blurry' }, 'id-enzo'));
  assert(!isVerifiedSubject({ ...base, unsafe: true }, 'id-enzo'));
  assert(!isVerifiedSubject(undefined, 'id-enzo'));
  assert(!isVerifiedSubject({ ...base, screenCapture: true }, 'id-enzo'));
});

Deno.test('burstFrameVerdict keeps everyday frames and removes only a sibling-led frame or real unsafety', () => {
  const kids = new Set(['id-enzo', 'id-mara']);
  const base = { mainSubject: 'group', childrenVisible: [], faceVisible: false, expression: 'upset' as const, quality: 'blurry' as const, unsafe: false, screenCapture: true };
  // Group, blurry, crying, screen recording: all stay.
  assertEquals(burstFrameVerdict(base, 'id-mara', kids), 'keep');
  assertEquals(burstFrameVerdict({ ...base, mainSubject: 'other' }, 'id-mara', kids), 'keep');
  // Mara's film, Enzo clearly the subject, Mara nowhere: out.
  assertEquals(burstFrameVerdict({ ...base, mainSubject: 'id-enzo', childrenVisible: ['id-enzo'] }, 'id-mara', kids), 'remove');
  // …unless Mara is also in the frame.
  assertEquals(burstFrameVerdict({ ...base, mainSubject: 'id-enzo', childrenVisible: ['id-enzo', 'id-mara'] }, 'id-mara', kids), 'keep');
  // Family films don't require any child.
  assertEquals(burstFrameVerdict({ ...base, mainSubject: 'id-enzo' }, null, kids), 'keep');
  assertEquals(burstFrameVerdict({ ...base, unsafe: true }, null, kids), 'remove');
  assertEquals(burstFrameVerdict({ ...base, mainSubject: 'none' }, null, kids), 'prefer_other_window');
  assertEquals(burstFrameVerdict(undefined, 'id-mara', kids), 'keep');
});

Deno.test('burstFrameVerdict: vision can\'t overrule tags on who a sibling-led frame shows', () => {
  const kids = new Set(['id-enzo', 'id-mara']);
  const seenAsEnzo = { mainSubject: 'id-enzo', childrenVisible: ['id-enzo'], faceVisible: true, expression: 'smiling' as const, quality: 'good' as const, unsafe: false, screenCapture: false };
  // Tagged Mara only (F2 round 3: a hooded photo of Mara read as Enzo): keep.
  assertEquals(burstFrameVerdict(seenAsEnzo, 'id-mara', kids, ['id-mara']), 'keep');
  // Tagged both: the ambiguity is real, vision decides.
  assertEquals(burstFrameVerdict(seenAsEnzo, 'id-mara', kids, ['id-enzo', 'id-mara']), 'remove');
});

Deno.test('buildFrameCheckRequestBody labels references by name and candidates by index', () => {
  const body = buildFrameCheckRequestBody(
    ['Enzo'],
    [{ name: 'Enzo', base64: 'AAA', contentType: 'image/jpeg' }],
    [{ base64: 'BBB', contentType: 'image/jpeg' }],
    'model-x',
  ) as { messages: { content: unknown }[] };
  const text = JSON.stringify(body.messages[1].content);
  assert(text.includes('REFERENCE — Enzo:') && text.includes('CANDIDATE index 0:'));
});

Deno.test('burstFrameVerdict: failClosed (public audience) drops unchecked and crying frames', () => {
  const kids = new Set(['id-enzo']);
  const base = { mainSubject: 'id-enzo', childrenVisible: ['id-enzo'], faceVisible: true, expression: 'smiling' as const, quality: 'good' as const, unsafe: false, screenCapture: false };
  assertEquals(burstFrameVerdict(undefined, null, kids, undefined, { failClosed: true }), 'remove');
  assertEquals(burstFrameVerdict({ ...base, expression: 'upset' }, null, kids, undefined, { failClosed: true }), 'remove');
  assertEquals(burstFrameVerdict({ ...base, expression: 'upset' }, null, kids), 'keep');
  assertEquals(burstFrameVerdict(base, null, kids, undefined, { failClosed: true }), 'keep');
});
