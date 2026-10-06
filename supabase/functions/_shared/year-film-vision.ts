// Year Film frame check (docs/plans/year-film.md §12 Q13; owner feedback
// 2026-09-27: "biggest smile → Tomás" was a group video). A vision pass over
// the frames that make a claim about a child — award beats, then/now close,
// voice-fallback clips — against a reference photo of each child.
//
// Pure: prompt, request body and parsing. The fetch lives with the caller.
// Fail-closed per frame: a frame with no valid verdict is treated as
// unverified, and unverified frames never back a claim.

export type FrameExpression = 'laughing' | 'big_smile' | 'smiling' | 'neutral' | 'upset' | 'not_visible';
export type FrameQuality = 'good' | 'blurry' | 'dark';

export interface FrameCheck {
  /** Child id when one of the reference children is clearly the main
   * subject; 'group' when several people share the frame equally; 'other'
   * for someone else; 'none' when no person is the subject. */
  mainSubject: string | 'group' | 'other' | 'none';
  /** Reference children visible anywhere in the frame. */
  childrenVisible: string[];
  /** The main subject's face is clearly visible (not turned away/covered). */
  faceVisible: boolean;
  expression: FrameExpression;
  quality: FrameQuality;
  /** Real nudity, toilet use, or a medical procedure — never in a film.
   * Everyday toddler life (diapers, shirtless, crying) is NOT unsafe (owner,
   * F2 round 2). */
  unsafe: boolean;
  /** A screenshot or screen recording (app UI, game overlays), or baby-
   * monitor / security-camera / night-vision footage (owner, F2 review). */
  screenCapture: boolean;
  /** Public-audience variant only (the holiday card film, owner 2026-10-05:
   * "anyone who scans the card can watch it"): a bare torso at any age, a
   * child in only a diaper or underwear, a bath/shower scene, any nudity,
   * toilet use, a medical procedure, or crying/distress. Absent on verdicts
   * from the normal prompt; for a public film a verdict without it is
   * treated as unsafe. */
  underdressed?: boolean;
}

/** Which prompt variant a check runs: `publicAudience` is the strict one
 * (holiday card film). Its verdicts are cached under a different key
 * (year-film-checks.ts) so a normal verdict never stands in for a strict one. */
export interface FrameCheckOptions {
  publicAudience?: boolean;
}

const EXPRESSIONS: ReadonlySet<string> = new Set(['laughing', 'big_smile', 'smiling', 'neutral', 'upset', 'not_visible']);
const QUALITIES: ReadonlySet<string> = new Set(['good', 'blurry', 'dark']);

export const FRAME_CHECK_BATCH = 16;

export interface VisionImage {
  base64: string;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
}

const UNSAFE_NORMAL =
  '- unsafe: true ONLY for nudity beyond everyday baby/toddler dress (a bare bottom or genitals), toilet/potty use, or a medical procedure. Diapers, swimsuits, a shirtless toddler, crying, tantrums and messy eating are ordinary family moments and NOT unsafe.';
const UNSAFE_PUBLIC =
  '- unsafe: true for any nudity (a bare bottom, genitals, bare breasts), toilet/potty use, or a medical procedure. When you cannot tell whether someone is nude, answer true. Swimwear at a beach or pool is not nudity.';
const UNDERDRESSED_PUBLIC =
  '- underdressed: this film is posted for ANYONE to watch (relatives, friends, strangers), so be careful. true if the frame shows ANY of: any nudity or someone partly undressed or being changed; a child in only a diaper, nappy or underwear OUTSIDE a beach/pool/swimming context; a bare torso, chest or back (any age) when the setting is NOT clearly a beach, pool, swimming or outdoor water play; a bath, bathtub, shower, sink-bath or someone being washed; toilet or potty use; a medical procedure (injection, thermometer, hospital bed with equipment); or a person crying or in distress. EXCEPTION: a bare torso is fine (false) when the setting is clearly a beach, pool, swimming, sprinkler or splash play outdoors and the person wears swimwear (swimsuit, swim trunks or shorts, bikini, swim-diaper pants all count as swimwear there); shirtless on the sand or in the water is normal and is NOT underdressed. Bare legs, arms and feet are always fine. When you cannot tell whether someone is nude, answer true. Otherwise false.';

export function buildFrameCheckSystemPrompt(childNames: string[], options: FrameCheckOptions = {}): string {
  const names = childNames.join(', ');
  const pub = options.publicAudience === true;
  return [
    'You check candidate frames for a family recap film. The film will say things like "the biggest smile award goes to <child>", so every verdict must be literally true of the image.',
    `First you see one REFERENCE photo per child (${names}), labeled with their name. Then numbered CANDIDATE frames, labeled by index only.`,
    'For EACH candidate index, report:',
    `- main_subject: the child's name (one of: ${names}) ONLY if that child is clearly the main subject — the largest, most central, in-focus person. "group" if several people share the frame with no single clear subject. "other" if the main subject is someone else (an adult, another child). "none" if there is no person.`,
    `- children_visible: names from (${names}) visible anywhere in the frame. Identify children only by comparison with the reference photos; if unsure, leave them out.`,
    "- face_visible: true only if the main subject's face is clearly visible (not turned away, covered, cropped or tiny).",
    '- expression of the main subject: "laughing" (open-mouth laugh), "big_smile" (wide smile, teeth showing), "smiling", "neutral", "upset" (crying, frowning), or "not_visible".',
    '- quality: "good", "blurry" (motion blur / out of focus on the subject) or "dark".',
    pub ? UNSAFE_PUBLIC : UNSAFE_NORMAL,
    ...(pub ? [UNDERDRESSED_PUBLIC] : []),
    '- screen_capture: true if it is a screenshot or screen recording (app or game UI, on-screen buttons, overlays), or baby-monitor, security-camera or night-vision footage (grainy grayscale, temperature/time overlays).',
    'When uncertain, choose the more conservative answer ("group"/"other" over a child\'s name; false over true for face_visible; "neutral" over a smile).',
    `Return STRICT JSON: {"frames":[{"index":0,"main_subject":"...","children_visible":["..."],"face_visible":true,"expression":"...","quality":"...","unsafe":false,${pub ? '"underdressed":false,' : ''}"screen_capture":false}]} — one entry per candidate index.`,
  ].join('\n');
}

/** Claim checks (F1): frames that back what the film says on screen — the
 * award winner, each child's chapter moments, then/now, whose voice clip it
 * is. GPT-6 Sol: on 85 frames Luna agreed with Sol on 88–91% of main
 * subjects (Sol vs Sol: 95%) and swapped the siblings once (Sol: never). */
export const CLAIM_CHECK_MODEL = 'gpt-6-sol';

/** The holiday card film's claim checks (owner, 2026-10-05): GPT-6.1 Sol. Live
 * birthday/monthly/year films keep CLAIM_CHECK_MODEL. */
export const HOLIDAY_CLAIM_CHECK_MODEL = 'gpt-6.1-sol';

/** Burst frame checks (F2): keep/drop only, 25–65 frames per film. GPT-6
 * Luna — 20× cheaper per token, and it matched Sol on every safety verdict
 * (owner, 2026-09-28: split the vision work by what it decides). */
export const FRAME_CHECK_MODEL = 'gpt-6-luna';

export function buildFrameCheckRequestBody(
  childNames: string[],
  references: (VisionImage & { name: string })[],
  candidates: VisionImage[],
  model: string,
  options: FrameCheckOptions = {},
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: `${references.length} reference photo(s), then ${candidates.length} candidate frame(s), index 0 to ${candidates.length - 1}.` },
  ];
  for (const ref of references) {
    content.push({ type: 'text', text: `REFERENCE — ${ref.name}:` });
    content.push({ type: 'image_url', image_url: { url: `data:${ref.contentType};base64,${ref.base64}`, detail: 'low' } });
  }
  candidates.forEach((image, index) => {
    content.push({ type: 'text', text: `CANDIDATE index ${index}:` });
    content.push({ type: 'image_url', image_url: { url: `data:${image.contentType};base64,${image.base64}`, detail: 'low' } });
  });
  return {
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildFrameCheckSystemPrompt(childNames, options) },
      { role: 'user', content },
    ],
  };
}

/** Per-frame validation: a malformed entry drops only that frame (which
 * then counts as unverified). Names map back to child ids. */
export function parseFrameCheckResponse(
  raw: string,
  candidateCount: number,
  childIdByName: Map<string, string>,
  options: FrameCheckOptions = {},
): Map<number, FrameCheck> {
  const out = new Map<number, FrameCheck>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  const list = (parsed as { frames?: unknown })?.frames;
  if (!Array.isArray(list)) return out;
  const idFor = (name: unknown) => (typeof name === 'string' ? childIdByName.get(name.trim().toLowerCase()) : undefined);

  for (const item of list) {
    const index = item?.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= candidateCount || out.has(index)) {
      continue;
    }
    const subjectRaw = typeof item.main_subject === 'string' ? item.main_subject.trim().toLowerCase() : '';
    const mainSubject = idFor(subjectRaw) ?? (['group', 'other', 'none'].includes(subjectRaw) ? subjectRaw : null);
    if (!mainSubject) continue;
    if (typeof item.face_visible !== 'boolean' || typeof item.unsafe !== 'boolean') continue;
    if (typeof item.screen_capture !== 'boolean') continue;
    // The strict variant must answer its extra question: no answer, no verdict.
    if (options.publicAudience && typeof item.underdressed !== 'boolean') continue;
    if (!EXPRESSIONS.has(item.expression) || !QUALITIES.has(item.quality)) continue;
    const visible = Array.isArray(item.children_visible)
      ? [...new Set(item.children_visible.map(idFor).filter((id: string | undefined): id is string => !!id))]
      : [];
    out.set(index, {
      mainSubject,
      childrenVisible: visible as string[],
      faceVisible: item.face_visible,
      expression: item.expression,
      quality: item.quality,
      unsafe: item.unsafe,
      screenCapture: item.screen_capture,
      ...(options.publicAudience ? { underdressed: item.underdressed as boolean } : {}),
    });
  }
  return out;
}

/** A strict (public-audience) verdict that passes: nothing the owner's public
 * rule excludes. A verdict without the strict field never passes. */
export function isPublicSafe(check: FrameCheck | undefined): boolean {
  return !!check && check.underdressed === false && !check.unsafe && check.expression !== 'upset';
}

/** The child is the clear, visible, safe subject of a usable frame. With
 * `publicAudience` (holiday card film) the strict verdict must also pass. */
export function isVerifiedSubject(check: FrameCheck | undefined, childId: string, options: FrameCheckOptions = {}): boolean {
  return !!check && check.mainSubject === childId && check.faceVisible && check.quality !== 'blurry' && !check.unsafe &&
    !check.screenCapture && (!options.publicAudience || isPublicSafe(check));
}

export type BurstVerdict = 'keep' | 'prefer_other_window' | 'remove';

/** What to do with a burst frame. Bursts flash by, so almost everything
 * stays (owner, F2 round 2: blurry, group, face-hidden, crying, screen and
 * monitor frames all belong). Removed only when unsafe, or — in a child's
 * birthday film — when a sibling is clearly the subject and the child isn't
 * visible at all (F2 round 1: Lucía's film had a clip of Tomás). Vision alone
 * can't overrule the tags on that: siblings look alike (F2 round 3 took a
 * Lucía-only photo for Tomás), so it only counts when the memory is also
 * tagged with that sibling. A clip whose window shows no one tries its
 * other windows first. Fail-open: no verdict keeps the frame — except
 * `failClosed` (public audiences: the holiday card film, owner 2026-10-04),
 * where no verdict removes it, a crying/frowning face goes too, and so do a
 * blurry frame with no face and a photo of a screen. */
export function burstFrameVerdict(
  check: FrameCheck | undefined,
  requiredChildId: string | null,
  ownChildIds: ReadonlySet<string>,
  frameTags?: readonly string[],
  options: { failClosed?: boolean; publicAudience?: boolean } = {},
): BurstVerdict {
  // `publicAudience` (the holiday card film) is the strict variant: it also
  // fails closed, and a verdict from the normal prompt (no `underdressed`
  // answer) or one that flags anything the owner excludes removes the frame.
  const failClosed = options.failClosed || options.publicAudience;
  if (!check) return failClosed ? 'remove' : 'keep';
  if (check.unsafe) return 'remove';
  if (options.publicAudience && check.underdressed !== false) return 'remove';
  if (failClosed && check.expression === 'upset') return 'remove';
  // Blurry with no face visible, or a photo of a screen: fine for a family's
  // own year film (bursts flash by), not for relatives and friends (the first
  // holiday render opened with a blurry, faceless torso clip).
  if (failClosed && ((check.quality === 'blurry' && !check.faceVisible) || check.screenCapture)) return 'remove';
  if (requiredChildId !== null) {
    // The model sometimes names the main subject but leaves them off the
    // visible list — the main subject is visible by definition.
    const childSeen = check.childrenVisible.includes(requiredChildId) || check.mainSubject === requiredChildId;
    const siblingIsSubject = check.mainSubject !== requiredChildId && ownChildIds.has(check.mainSubject) &&
      (frameTags === undefined || frameTags.includes(check.mainSubject));
    if (siblingIsSubject && !childSeen) return 'remove';
  }
  return check.mainSubject === 'none' ? 'prefer_other_window' : 'keep';
}

export function describeCheck(check: FrameCheck | undefined, names: Map<string, string>): string {
  if (!check) return 'vision: unchecked';
  const subject = names.get(check.mainSubject) ?? check.mainSubject;
  return `vision: ${subject}${check.faceVisible ? '' : ' (face hidden)'} · ${check.expression}${
    check.quality !== 'good' ? ` · ${check.quality}` : ''
  }${check.unsafe ? ' · UNSAFE' : ''}${check.underdressed ? ' · UNDERDRESSED' : ''}${check.screenCapture ? ' · SCREEN/MONITOR' : ''}`;
}
