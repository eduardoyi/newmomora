// Year Film frame check (docs/plans/year-film.md §12 Q13; owner feedback
// 2026-09-27: "biggest smile → Enzo" was a group video). A vision pass over
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
}

const EXPRESSIONS: ReadonlySet<string> = new Set(['laughing', 'big_smile', 'smiling', 'neutral', 'upset', 'not_visible']);
const QUALITIES: ReadonlySet<string> = new Set(['good', 'blurry', 'dark']);

export const FRAME_CHECK_BATCH = 16;

export interface VisionImage {
  base64: string;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
}

export function buildFrameCheckSystemPrompt(childNames: string[]): string {
  const names = childNames.join(', ');
  return [
    'You check candidate frames for a family recap film. The film will say things like "the biggest smile award goes to <child>", so every verdict must be literally true of the image.',
    `First you see one REFERENCE photo per child (${names}), labeled with their name. Then numbered CANDIDATE frames, labeled by index only.`,
    'For EACH candidate index, report:',
    `- main_subject: the child's name (one of: ${names}) ONLY if that child is clearly the main subject — the largest, most central, in-focus person. "group" if several people share the frame with no single clear subject. "other" if the main subject is someone else (an adult, another child). "none" if there is no person.`,
    `- children_visible: names from (${names}) visible anywhere in the frame. Identify children only by comparison with the reference photos; if unsure, leave them out.`,
    "- face_visible: true only if the main subject's face is clearly visible (not turned away, covered, cropped or tiny).",
    '- expression of the main subject: "laughing" (open-mouth laugh), "big_smile" (wide smile, teeth showing), "smiling", "neutral", "upset" (crying, frowning), or "not_visible".',
    '- quality: "good", "blurry" (motion blur / out of focus on the subject) or "dark".',
    '- unsafe: true ONLY for nudity beyond everyday baby/toddler dress (a bare bottom or genitals), toilet/potty use, or a medical procedure. Diapers, swimsuits, a shirtless toddler, crying, tantrums and messy eating are ordinary family moments and NOT unsafe.',
    '- screen_capture: true if it is a screenshot or screen recording (app or game UI, on-screen buttons, overlays), or baby-monitor, security-camera or night-vision footage (grainy grayscale, temperature/time overlays).',
    'When uncertain, choose the more conservative answer ("group"/"other" over a child\'s name; false over true for face_visible; "neutral" over a smile).',
    'Return STRICT JSON: {"frames":[{"index":0,"main_subject":"...","children_visible":["..."],"face_visible":true,"expression":"...","quality":"...","unsafe":false,"screen_capture":false}]} — one entry per candidate index.',
  ].join('\n');
}

/** Claim checks (F1): frames that back what the film says on screen — the
 * award winner, each child's chapter moments, then/now, whose voice clip it
 * is. GPT-6 Sol: on 85 frames Luna agreed with Sol on 88–91% of main
 * subjects (Sol vs Sol: 95%) and swapped the siblings once (Sol: never). */
export const CLAIM_CHECK_MODEL = 'gpt-6-sol';

/** Burst frame checks (F2): keep/drop only, 25–65 frames per film. GPT-6
 * Luna — 20× cheaper per token, and it matched Sol on every safety verdict
 * (owner, 2026-09-28: split the vision work by what it decides). */
export const FRAME_CHECK_MODEL = 'gpt-6-luna';

export function buildFrameCheckRequestBody(
  childNames: string[],
  references: (VisionImage & { name: string })[],
  candidates: VisionImage[],
  model: string,
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
      { role: 'system', content: buildFrameCheckSystemPrompt(childNames) },
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
    });
  }
  return out;
}

/** The child is the clear, visible, safe subject of a usable frame. */
export function isVerifiedSubject(check: FrameCheck | undefined, childId: string): boolean {
  return !!check && check.mainSubject === childId && check.faceVisible && check.quality !== 'blurry' && !check.unsafe &&
    !check.screenCapture;
}

export type BurstVerdict = 'keep' | 'prefer_other_window' | 'remove';

/** What to do with a burst frame. Bursts flash by, so almost everything
 * stays (owner, F2 round 2: blurry, group, face-hidden, crying, screen and
 * monitor frames all belong). Removed only when unsafe, or — in a child's
 * birthday film — when a sibling is clearly the subject and the child isn't
 * visible at all (F2 round 1: Mara's film had a clip of Enzo). Vision alone
 * can't overrule the tags on that: siblings look alike (F2 round 3 took a
 * Mara-only photo for Enzo), so it only counts when the memory is also
 * tagged with that sibling. A clip whose window shows no one tries its
 * other windows first. Fail-open: no verdict keeps the frame. */
export function burstFrameVerdict(
  check: FrameCheck | undefined,
  requiredChildId: string | null,
  ownChildIds: ReadonlySet<string>,
  frameTags?: readonly string[],
): BurstVerdict {
  if (!check) return 'keep';
  if (check.unsafe) return 'remove';
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
  }${check.unsafe ? ' · UNSAFE' : ''}${check.screenCapture ? ' · SCREEN/MONITOR' : ''}`;
}
