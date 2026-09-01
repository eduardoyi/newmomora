/**
 * Memory Book outline generation -- runtime-agnostic shared logic (V5a slice,
 * "part B": extracted verbatim, byte-identical, out of
 * `supabase/scripts/eval-memory-book-outline.ts` so a Cloudflare Workflow
 * worker can import it via a relative path, same precedent as
 * `cloudflare/memory-illustration-worker/src/workflow.ts` importing
 * `../../../supabase/functions/_shared/prompts.ts`).
 *
 * This module holds ONLY the pure pieces of the outline pipeline: the
 * curation prompt builders (including the COVER CANDIDATES criteria), the
 * OpenAI request-body builders, response parsing + validation (never trust
 * the model), the cover-candidate vision-verification pass's prompt/parse/
 * apply steps, usage/cost summation, and the outline-shape types these all
 * share. It deliberately does NOT include: CLI argument parsing, Supabase/R2
 * data loading, the actual `fetch` calls to OpenAI, file/thumbnail writes, or
 * any other IO -- those stay in the eval script (and will get their own
 * production home in the worker) since they differ per runtime. No `Deno.*`
 * globals or `import.meta.main` here -- plain TS + `fetch`-shaped types only,
 * so Deno scripts, Supabase Edge Functions, and Cloudflare Workers can all
 * import this file unchanged.
 *
 * `supabase/scripts/eval-memory-book-outline.ts` is the CLI wrapper around
 * this module (deterministic scaffold building, DB/R2 reads, candidate
 * generation, page accounting, reading-order assembly, and console/file
 * output all stay there) -- see that file's own header comment for the full
 * pipeline this is one stage of.
 */

// ── OpenAI usage + cost ─────────────────────────────────────────────────

export interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

/** USD per 1M tokens, for the run's cost line (owner request, 2026-08-31 —
 * the outline pass was the one unmeasured stage of preview generation).
 * Source: developers.openai.com/api/docs/pricing, fetched 2026-08-31.
 * Unknown models print tokens only, never a wrong dollar figure. */
export const PRICE_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  'gpt-5.6-sol': { input: 4.0, output: 20.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};

/** Sums two OpenAI usage reports (owner request, 2026-08-31/09-01: the
 * run's cost line covers every call the run makes, not just the first --
 * see the `usage` combination in `main()`). Either side may be `null`
 * (a call that was never made, or fetched no usage back). */
export function sumOpenAiUsage(a: OpenAiUsage | null, b: OpenAiUsage | null): OpenAiUsage | null {
  if (!a) return b;
  if (!b) return a;
  return { prompt_tokens: a.prompt_tokens + b.prompt_tokens, completion_tokens: a.completion_tokens + b.completion_tokens };
}

// ── Photo orientation (owner root-cause fix, 2026-08-27: the AI nominated
// only portrait photos as panorama candidates because orientation was never
// in its metadata at all) ────────────────────────────────────────────────

export type PhotoOrientation = 'wide' | 'tall' | 'square';

export interface PhotoOrientationInfo {
  orientation: PhotoOrientation;
  ratio: number;
}

/** A `wide` photo at or above this ratio gets its approximate ratio spelled
 * out (e.g. "wide 1.7:1") since panorama nomination wants genuinely wide,
 * not just technically-landscape. */
const WIDE_RATIO_CALLOUT_THRESHOLD = 1.5;

/** The compact marker appended to a memory's metadata row -- `null` when
 * there's no aspect data to report (the field is simply omitted, never
 * shown as "unknown"). */
export function formatOrientationMarker(info: PhotoOrientationInfo | null): string | null {
  if (!info) return null;
  if (info.orientation === 'wide' && info.ratio >= WIDE_RATIO_CALLOUT_THRESHOLD) {
    return `wide ${info.ratio.toFixed(1)}:1`;
  }
  return info.orientation;
}

// ── Per-memory features (the outline's core "memory as fed to the AI" shape) ─

export interface MemoryMilestoneFeature {
  milestoneId: string;
  name: string;
  detail: string | null;
  outOfBand: boolean;
}

export interface TaggedMemberFeature {
  firstName: string;
  personType: 'child' | 'adult' | 'unknown';
  /** This member's own profile nicknames (`family_members.nicknames`),
   * `[]` when the profile has none -- surfaced so the AI can prefer a
   * nickname over the first name in generated copy (never text-mined). */
  nicknames: string[];
}

export interface MemoryFeature {
  id: string;
  date: string;
  topics: string[];
  topicDetails: Record<string, string>;
  emotion: string | null;
  hasText: boolean;
  /** First 120 chars of `content`. Local review-artifact + AI-prompt use
   * only -- NEVER logged to stdout (PII rule). */
  excerpt: string | null;
  /** Full content character count -- NEVER the content itself, just its
   * length, so this stays safe to log per the PII rule. */
  textLength: number;
  photoCount: number;
  videoCount: number;
  previewKey: string | null;
  engagementCount: number;
  milestones: MemoryMilestoneFeature[];
  /** Age turned, from the deterministic `birthday` milestone row. */
  birthdayAgeTurned: number | null;
  taggedToChild: boolean;
  /** Every tagged person's own name/nickname (as the family wrote it) plus
   * child/adult/unknown, sent to the AI as the ONLY sanctioned source of
   * relationship words in titles/rationales -- never inferred from photos
   * or topic tags. */
  taggedMembers: TaggedMemberFeature[];
  /** The first photo asset's orientation, straight from
   * `memory_media.aspect_ratio` -- null when no photo, or the first photo
   * has no aspect data. Sent to the AI so it can actually judge panorama/
   * hero suitability instead of guessing blind. */
  photoOrientation: PhotoOrientationInfo | null;
}

// ── Unified candidate model (every generator feeds the SAME AI call) ───────

export type CandidateKind = 'topic' | 'people-pair' | 'emotion';

/** One curation candidate, regardless of which generator produced it. `id`
 * is globally unique (`topic:<id>`, `people:<memberId>`, `emotion:<key>`)
 * and is what the AI response's `candidate_id` field references. */
export interface Candidate {
  id: string;
  kind: CandidateKind;
  defaultTitle: string;
  memoryIds: string[];
}

// ── Backbone segment shape (chronological backbone, segmented by month) ────

export interface BackboneSegment {
  id: string;
  label: string;
  monthKeys: string[];
  memoryIds: string[];
}

// ── Special backbone segment flags (birth/birthday month titles) ───────────

export type SpecialSegmentFlagKind = 'birth' | 'birthday';

export interface SpecialSegmentFlag {
  segmentId: string;
  /** The specific "YYYY-MM" that triggered this flag -- used to bridge a
   * flag computed on the ORIGINAL (pre-budget) segment list to whichever
   * FINAL segment the same calendar month lands in after re-segmentation,
   * since segment ids/boundaries can change but the flagged month cannot. */
  month: string;
  kind: SpecialSegmentFlagKind;
  ageTurned?: number;
}

// ── LANGUAGE resolution (plan round-18, "books are standalone": caption-less
// books came out in ENGLISH because "the family's journal language" was
// inferred by the model purely from captions it never had. Owner chain: (1)
// predominant language of the ACCOUNT's captions (whole archive, not the
// window) -- the MODEL resolves this; (2) `families.gallery_caption_language`;
// (3) 'en'. This function only supplies the code-level safety net for steps
// (2)/(3) when the model's own field is missing or malformed.) ─────────────

/** Loose BCP-47 check (same shape as the DB's own
 * `families_gallery_caption_language_check` constraint) -- used both to
 * validate the model's returned `language` field and the configured
 * `gallery_caption_language` fallback value. Not a full BCP-47 validator
 * (there isn't a canonical subtag registry here), just "plausibly a
 * language tag" so a garbled model response never gets treated as a
 * language. */
export const BCP47_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** The final code-level fallback (owner chain step 3) when neither the
 * model's own resolution nor the configured language is usable. */
export const FALLBACK_LANGUAGE = 'en';

/**
 * Code-level safety net around the model's own LANGUAGE resolution (owner
 * chain, steps 2 and 3 -- step 1, "predominant caption language", is the
 * model's job alone since only it can read the caption text given to it).
 * `modelLanguage` is the model's raw `language` field (already trimmed;
 * `null` when absent or blank); `configuredLanguage` is
 * `families.gallery_caption_language` (already trimmed; `null` when unset/
 * blank). Pure and exported so the fallback chain is unit-testable
 * independent of the OpenAI round trip.
 */
export function resolveOutlineLanguage(modelLanguage: string | null, configuredLanguage: string | null): string {
  if (modelLanguage && BCP47_PATTERN.test(modelLanguage)) return modelLanguage;
  if (configuredLanguage && BCP47_PATTERN.test(configuredLanguage)) return configuredLanguage;
  return FALLBACK_LANGUAGE;
}

/** Minimum non-birthday milestone memories required for the Firsts section
 * to exist at all (owner round-4 decision, 2026-08-27: a live regeneration
 * had the owner dismiss a wrong milestone match, leaving exactly ONE real
 * milestone behind -- the OLD >=2 gate then dropped the whole Firsts
 * section, silently losing that one genuine milestone from the book, AND
 * left the model guessing a `milestone_id` from the bare name it saw on the
 * backbone memory line (since the FIRSTS MILESTONES block -- the only place
 * real `milestone_id` slugs are given out -- was withheld below the same
 * threshold), producing an `unknown_firsts_milestone` violation for a
 * milestone that was perfectly real. A single genuine victory still earns
 * the closing section, so this is 1: every location that gates on "is
 * Firsts present" (the prompt announcement, the FIRSTS MILESTONES block,
 * and the placement decision) must read this SAME constant, never a
 * hardcoded number, so they can never drift apart again. */
export const FIRSTS_MIN_MILESTONES = 1;

// ── AI call: prompt construction ─────────────────────────────────────────

export function buildOutlineSystemPrompt(): string {
  return [
    "You are the curator for a premium printed baby/family memory book, built from a parent's private journal entries. You receive a deterministic skeleton (already decided in code: cover, title page, a portrait timeline, a chronological backbone segmented by month, possibly birthday spreads, a Firsts spread that CLOSES the book, and a closing page) and a list of SPREAD CANDIDATES from three sources: topic clusters, people-pair spreads (\"With <Name>\"), and emotion spreads (\"The funny ones\"). Your job is to select and sequence -- not to write or rewrite.",
    '',
    "RULES:",
    "- The parent's text is sacred and will be printed verbatim later. You are selecting and sequencing memories, never rewriting or paraphrasing their words.",
    '- Select for QUALITY, never for a page count. You are NOT told a target page count and must never invent one, guess one, or aim for one. The printed book\'s physical page budget is enforced DOWNSTREAM, automatically, by the renderer -- selecting more spreads/memories than end up fitting is normal and EXPECTED, not a mistake to correct. Never omit an otherwise-worthy candidate spread or memory just to keep the book "shorter" or because you suspect there are "too many" already -- that is not your job and second-guessing it makes the book worse, not better.',
    '- Prefer emotional variety over repetition: do not fill a book with near-duplicate moments when other emotions/topics are available.',
    '- When a memory fits several spreads, it belongs where it is scarcest -- prefer placing it in the spread it will do more work for, since code will only keep it in one place.',
    '- Never invent milestones, dates, or facts not present in the data you were given.',
    '- Never write "missing" or "behind" language about development -- celebrate what exists only.',
    '- If a Firsts spread is present (listed below), draft its title around the framing "big and small victories this year" -- in the family\'s own journal language (the same way you draft every other spread title), not a literal translation of that English phrase.',
    '',
    'LANGUAGE: write EVERY piece of copy you generate below (spread titles, kickers, segment_titles, firsts_title, warm_name, dedication, back_cover_line, editorial_note) in ONE consistent language -- the family\'s own journal-writing language, resolved in this exact order: (1) the predominant language of the actual caption text you can see -- the excerpts on the MEMORIES lines below, plus a LANGUAGE EVIDENCE ONLY block when the window itself has few captions (see below) -- judged from the real weight of evidence, never from a single foreign word or name; (2) if you cannot see enough caption text anywhere to judge a language, the CONFIGURED LANGUAGE value given below (when one is provided); (3) if neither is available, English. A LANGUAGE EVIDENCE ONLY block, when present, is recent caption text from this family\'s wider archive shown SOLELY so you can judge their writing language -- it is not part of this book, never eligible for a spread/backbone/Firsts, and never quotable as a title source. Return your resolved choice as a `language` field (a BCP-47 code, e.g. "es", "es-MX", "en") -- this is REQUIRED and must be the language you actually wrote everything else in, not a separate guess.',
    '',
    'FIRSTS WARM NAMES: for EACH row listed under FIRSTS MILESTONES below (if any), write a `warm_name` -- the milestone rephrased as a warm second-person sentence, in the family\'s journal language, addressed to the child. Examples: "Monta bicicleta sin pedales" -> "Aprendiste a montar bicicleta sin pedales"; "Primer corte de pelo" -> "Tuviste tu primer corte de pelo". This is connective text (editable downstream) and must NEVER alter the parent\'s own memory caption -- it stands alongside it, not instead of it. Echo back the exact `memory_id` and `milestone_id` from that row so code can match your `warm_name` to the right entry.',
    '',
    'RELATIONSHIP WORDS (aunt, uncle, grandma, "nonno", "abuelo", "zio", "mami", etc.) may ONLY come from the TAGGED PEOPLE listed on each memory below: either their OWN profile nickname (the "nn:" field -- see PEOPLE-PAIR SPREAD TITLES below, this needs no further evidence) or their first name as the family actually wrote it (reasoning from a name like "Nonna Rosa" or "Tio Mike" is fine, that is user-authored evidence). NEVER infer a relationship from what people look like in a photo, and NEVER infer one just because a topic tag like `extended-family` or `grandparents` is present -- a real failure titled a cluster of grandparent photos "Entre tias, tios y primos" (aunts, uncles, and cousins) purely from the topic tag, when the tagged people did not support that specific relationship mix. When you are not confident a specific relationship word is supported by the tagged people (profile nickname OR name), use a warm generic title instead (spirit: "Look who came to see you") rather than guessing who someone is.',
    '',
    'PEOPLE-PAIR SPREAD TITLES AND NAMES IN COPY: when naming a family member -- a people-pair spread title ("Con <Name>"), or anywhere else you write that person\'s name in generated copy -- PREFER their own profile nickname (the "nn:" field on their tagged-people entry in MEMORIES below) over their first name. This is PROFILE data, not text evidence -- it needs no separate confirmation, the profile IS the evidence. Use it in the family\'s journal language with natural article handling: a kinship nickname usually takes an article ("la nonna", "el nonno", "la mami"), a pet name usually does not ("Con Billy"). Examples: "Con la nonna", "Con papi", "Tus momentos con Billy". If a person has more than one profile nickname, pick whichever reads most naturally as a title -- you do not need to use all of them. Fall back to their first name ("Con Mirian") ONLY when their tagged-people entry has no "nn:" field at all -- never invent a nickname that is not listed. This is separate from a RELATIONSHIP WORD you might want to CLAIM about someone (see RELATIONSHIP WORDS above) -- a profile nickname is just how you address them, not a claim about who they are.',
    '',
    'SPREAD TITLES HAVE TWO MODES -- declare which one you used via `title_mode`:',
    '- "quote": verbatim (or lightly trimmed) text lifted from a memory INSIDE the spread. Preferred when a great one exists, especially for emotion/people-pair spreads (real examples that worked: "Ay Dios mío" on a funny spread, "Papi, con amor, por favor" on a tender one). Set `title_source_memory_id` to that memory\'s id -- code verifies the title actually appears in that memory\'s real text, so never fabricate or paraphrase a "quote".',
    '- "descriptive": any title that names a concrete place/activity/object.',
    '',
    'DESCRIPTIVE TITLES (and any QUOTE title that names something concrete, e.g. mentions a specific place) MUST BE TRUE OF EVERY MEMORY IN THE SPREAD. If member memories vary, choose a more general title that still fits all of them. If a single memory does not fit an otherwise-specific title, leave that memory OUT of the spread (it returns to backbone eligibility) rather than stretching the title. Real failure: a boat-trip memory was included inside a spread titled "¡Nos vamos en avión!" ("We\'re going by plane!") -- a boat is not a plane, so it should have been excluded from that spread, not included under a title that no longer fit every memory. A quote does not exempt a title from this rule.',
    '',
    'PROTAGONIST RULE (spread membership -- applies equally to topic, people-pair, AND emotion candidates, e.g. "the funny ones"): a caption-less memory -- no parent text (the MEMORIES line below reads hasText "n") -- that has this child tagged is ALWAYS admissible to a spread on that basis alone; being present in an untitled photo is enough, never require more evidence than that. The exclusion applies ONLY when a memory HAS an explicit narrative caption (parent text that tells a specific story, not just a label) AND that story clearly centers someone else, with this child merely mentioned or visible while the text is about another person\'s moment -- that memory stays in the chronological backbone instead (never dropped from the book, just not pulled into the spread). Real failure: a funny-moments spread included a caption telling a burger-dinner story that centers the child\'s brother -- it should have stayed in the backbone, not been pulled into the spread on the strength of a topic/emotion tag alone. When you are not sure whether a caption centers this child or someone else, leave the memory in the backbone rather than guessing it into a spread it may not have earned.',
    '',
    'RATIONALES ARE INTERNAL, NEVER BOOK COPY. Every `rationale` value is a private curation note for the human reviewing this outline -- it is never printed in the book. Each one must:',
    '- Cite concrete evidence: which topic/emotion/milestone applies, engagement (likes/comments), has_text, or "only photo of X" -- something checkable in the data you were given.',
    '- Be telegraphic, max ~12 words. Not a sentence written for a reader.',
    '- GOOD: "only travel memory with text; high engagement"',
    '- BAD: "establishes adventure as part of the year" (this is prose written to justify a choice, not evidence)',
    '',
    'SPECIAL BACKBONE SEGMENT TITLES: some backbone segments below are flagged as the child\'s BIRTH month or a BIRTHDAY month. For ONLY those flagged segments (never any other segment), draft a special title in the family\'s journal language -- birth in the spirit of "welcome to the world", birthday in the spirit of "the month you turned N". Return these in `segment_titles`, keyed by the flagged segment\'s id. Do not add an entry for a segment that was not flagged.',
    '',
    'KICKER (antetítulo): for a THEMED spread ONLY (never for months/Firsts/birthday), you may add a `kicker` -- a short thematic eyebrow line that sits above the title (the design renders it in small caps), <=6 words, journal language. It is connective text, editable later, never parent text. Examples: "lo que nos hiciste reír" above the title "Ay Dios mío"; "lo que más te gustó hacer" above the title "Construir y jugar". Optional -- omit it rather than force one.',
    '',
    'HERO CANDIDATES: across the WHOLE book (any eligible memory, not just ones you selected into a spread), pick up to 5 `hero_candidates` -- the strongest single images (not videos) of the year, worth a full-bleed page or the cover. Each memory\'s row shows its first photo\'s orientation (`wide`, `tall`, or `square`, omitted when unknown) -- prefer `wide` or `square` for a full-bleed page; a `tall` photo makes a poor full-page bleed on a square page, but it is not forbidden if it is genuinely the strongest image.',
    '',
    'COVER CANDIDATES: separately from hero_candidates, pick up to 5 `cover_candidates` -- book-wide candidates for the COVER specifically, ranked BEST-FIRST. The cover has its own, stricter bar than a full-bleed page: it is the first thing anyone sees, so a technically strong image can still be the WRONG cover. Each candidate MUST be an actual photograph that features this child WITH THEIR FACE VISIBLE -- not a video frame, not a screenshot. A candidate MUST NOT be a medical or hospital setting (visible medical equipment, a procedure in progress, an unclothed newborn in a clinical context) -- even a technically sharp, well-composed image is disqualified if the setting reads as medical. A candidate MUST NOT be a photo OF a drawing, document, screen, or other artwork (a photo of a child\'s drawing is not a photo of the child) -- and this includes photos where the child appears only INSIDE framed or printed artwork (a photo of a framed painting or printed portrait OF the child is a photo of an object, not of the child). A candidate MUST be a single continuous photograph: never a collage, diptych, multi-panel composite, or side-by-side frames -- a visible seam or panel boundary disqualifies the image no matter how good each panel is. Beyond those hard rules, prefer warm, well-lit, uncluttered images where the child is the clear, unambiguous subject -- not a crowded group shot, not a dark or blurry one. A memory may be both a hero candidate and a cover candidate. If NO eligible memory clears this bar, return an empty list -- never nominate a disqualified image just to avoid an empty list; the renderer has its own fallback for that case.',
    '',
    'PANORAMA CANDIDATES: across the WHOLE book, nominate EVERY qualifying memory as a `panorama_candidate` -- there is no cap, so do not ration these. NOMINATE GENEROUSLY: you cannot see pixel dimensions, only orientation, so under-nomination is the real failure mode -- a real incident had the model nominating only 1-2 candidates and losing every panorama to a downstream resolution check. Aim for 5-10 candidates whenever the archive plausibly has that many wide/scenic memories; over-nomination costs nothing (a resolution filter downstream silently drops anything too small to print at 2:1 -- that is its job, not yours), but under-nomination kills a panoramic spread outright. A panorama spans TWO PAGES at roughly 2:1 -- a `tall` or `square` photo can NEVER work here, no matter how scenic; a candidate MUST show `wide` in its metadata row (and the wider the better -- prefer a called-out ratio like "wide 1.7:1" over a plain "wide"). Beyond orientation, qualifying also means scenic: a landscape, a vista, an open space, with no faces near the center of the frame -- judge that part from the memory\'s topics/labels/description context (you are not shown the actual image). Order the list BEST-FIRST (widest and most scenic first) -- the renderer uses roughly 1 spread per ~20 pages, picking down your list in order, so ranking matters more than count. Every book should open up into at least one panoramic breath WHEN a genuinely wide, scenic memory exists -- but if none of the `wide` memories are actually scenic (or no memory is `wide` at all), returning an EMPTY list is the correct, expected answer; never nominate a tall or square photo just to avoid an empty list. A memory may be both a hero candidate and a panorama candidate. These are human-reviewed downstream, so nominate confidently and completely rather than leaving qualifying ones out of caution.',
    '',
    'DEDICATION AND BACK COVER LINE: two more pieces of connective text, same class as the kicker/editorial note (journal language, editable downstream, never parent text).',
    '- `dedication`: a short dedication-page body, 2-3 sentences, referencing the scope\'s span and spirit. Owner round-3 rule: do NOT open with a salutation like "Para <name>," -- the printed page\'s own furniture already prints that greeting, so your text is only the body that follows it; opening with one duplicates it on the page. Canvas example (do not reuse verbatim, write fresh for this book): "Este año aprendiste a decir casi todo. Aquí está guardado lo que dijiste, lo que hiciste y lo que nos hiciste sentir, del 23 de octubre de 2024 al 22 de octubre de 2025."',
    '- `back_cover_line`: one short colophon line for the back cover. Canvas spirit (do not reuse verbatim): "Este libro recoge un año de recuerdos, escrito día a día."',
    '',
    'Return STRICT JSON with this shape:',
    '{',
    '  "language": "<REQUIRED -- resolved BCP-47 code for the language every field below is written in, e.g. \\"es\\", \\"es-MX\\", \\"en\\" -- see LANGUAGE above>",',
    '  "spreads": [',
    '    {',
    '      "candidate_id": "<one of the candidate ids given to you, e.g. \\"topic:beach\\", \\"people:<memberId>\\", \\"emotion:funny\\">",',
    '      "insert_after_segment_index": <integer, -1 means "right at the start, before the first backbone segment">,',
    '      "title": "<short warm page title>",',
    '      "title_mode": "quote" | "descriptive",',
    '      "title_source_memory_id": "<required when title_mode is quote -- must be one of this spread\'s own memory_ids -- omit/null for descriptive>",',
    '      "kicker": "<optional, <=6 words, journal language -- see KICKER above>",',
    '      "memory_ids": ["<3 to 6 memory ids from that candidate\'s member list -- omit any that would break the title-fits-all rule>"],',
    '      "rationale": { "<memory_id>": "<internal, evidence-based, <=12 words -- see RATIONALES above>" }',
    '    }',
    '  ],',
    '  "backbone_highlights": [',
    '    { "segment_id": "<a backbone segment id>", "memory_ids": ["<ids in that segment worth a full page>"], "rationale": { "<memory_id>": "<internal, evidence-based, <=12 words>" } }',
    '  ],',
    '  "hero_candidates": ["<up to 5 memory ids -- see HERO CANDIDATES above>"],',
    '  "cover_candidates": ["<up to 5 memory ids, best-first -- see COVER CANDIDATES above>"],',
    '  "panorama_candidates": ["<ALL qualifying memory ids, best-first, no cap -- see PANORAMA CANDIDATES above -- at least 1 whenever plausible>"],',
    '  "segment_titles": { "<flagged segment id>": "<special birth/birthday title in journal language -- see SPECIAL BACKBONE SEGMENT TITLES above>" },',
    '  "firsts_title": "<only if a Firsts spread is listed below -- its draft title, journal-language \'big and small victories this year\' framing>",',
    '  "firsts_milestones": [',
    '    { "memory_id": "<a memory id from a FIRSTS MILESTONES row>", "milestone_id": "<that row\'s milestone_id, echoed back exactly>", "warm_name": "<warm second-person rephrasing -- see FIRSTS WARM NAMES above>" }',
    '  ],',
    '  "dedication": "<2-3 sentence dedication-page body, NO salutation -- see DEDICATION AND BACK COVER LINE above>",',
    '  "back_cover_line": "<one short colophon line -- see DEDICATION AND BACK COVER LINE above>",',
    '  "editorial_note": "<INTERNAL ONLY, never printed in the book -- 2-3 sentences on the arc of this book for the human reviewer>"',
    '}',
    '',
    'Omit a candidate entirely if it is not worth including -- a QUALITY judgment (repetition, weak evidence, does not hold together), never a page-budget one; see the "Select for QUALITY, never for a page count" rule above. Only reference memory ids and segment/candidate ids that were given to you.',
  ].join('\n');
}

export interface OutlineSkeletonSummaryInput {
  childName: string;
  scopeLabel: string;
  windowStart: string;
  windowLastDay: string;
  backboneSegments: BackboneSegment[];
  firstsCount: number;
  birthdaySpreads: Array<{ ageTurned: number; memoryCount: number }>;
  throughTheYearsCount: number;
  /** Segments flagged for a special birth/birthday title -- computed on
   * these SAME (original, pre-budget) `backboneSegments`. */
  specialSegments: SpecialSegmentFlag[];
  /** `families.gallery_caption_language`, trimmed, `null` when unset/blank
   * -- LANGUAGE resolution chain step (2), shown to the model in the
   * LANGUAGE CONTEXT block below regardless of window caption count (it
   * costs nothing to include and is the model's fallback when caption
   * evidence runs out). */
  configuredLanguage: string | null;
  /** Up to a caller-chosen limit of recent account-wide non-empty captions
   * -- populated by the caller ONLY when the window's own caption count is
   * sparse; `[]` otherwise (the window's own MEMORIES block is evidence
   * enough on its own). LANGUAGE EVIDENCE ONLY: never eligible for a
   * spread/backbone/Firsts, never a quote source. */
  languageEvidenceCaptions: string[];
}

export function buildOutlineUserPrompt(
  skeleton: OutlineSkeletonSummaryInput,
  candidates: Candidate[],
  features: Map<string, MemoryFeature>,
): string {
  const lines: string[] = [];

  lines.push(
    `BOOK: ${skeleton.childName} -- ${skeleton.scopeLabel} (${skeleton.windowStart} to ${skeleton.windowLastDay})`,
  );
  lines.push(`CONFIGURED LANGUAGE: ${skeleton.configuredLanguage ?? '(not set)'} -- see LANGUAGE above`);
  if (skeleton.languageEvidenceCaptions.length > 0) {
    lines.push('');
    lines.push(
      'LANGUAGE EVIDENCE ONLY (recent account-wide captions -- for judging the family\'s writing language ONLY; not selectable, never quotable, not part of this book):',
    );
    for (const caption of skeleton.languageEvidenceCaptions) {
      lines.push(`- "${caption.replace(/\n/g, ' ')}"`);
    }
  }
  lines.push('');
  lines.push(`Through-the-years portraits in scope: ${skeleton.throughTheYearsCount}`);
  lines.push(
    `Firsts (non-birthday explicit milestones) in scope: ${skeleton.firstsCount}${skeleton.firstsCount >= FIRSTS_MIN_MILESTONES ? ' -- this spread CLOSES the book, draft its title now' : ''}`,
  );
  if (skeleton.birthdaySpreads.length > 0) {
    lines.push(
      `Birthdays in scope: ${skeleton.birthdaySpreads.map((b) => `turns ${b.ageTurned} (${b.memoryCount} memories)`).join(', ')}`,
    );
  }
  lines.push('');

  if (skeleton.firstsCount >= FIRSTS_MIN_MILESTONES) {
    lines.push('FIRSTS MILESTONES (write a warm_name for EACH row -- see FIRSTS WARM NAMES above):');
    const sortedFeatures = [...features.values()].sort((a, b) => a.date.localeCompare(b.date));
    for (const feature of sortedFeatures) {
      for (const milestone of feature.milestones) {
        lines.push(`- memory_id="${feature.id}" milestone_id="${milestone.milestoneId}" ("${milestone.name}")`);
      }
    }
    lines.push('');
  }

  lines.push('BACKBONE SEGMENTS (chronological, in order -- index is what insert_after_segment_index refers to):');
  const specialBySegmentId = new Map(skeleton.specialSegments.map((f) => [f.segmentId, f]));
  skeleton.backboneSegments.forEach((segment, index) => {
    const flag = specialBySegmentId.get(segment.id);
    const flagDesc = flag
      ? flag.kind === 'birth'
        ? ' -- FLAGGED: birth month, draft a segment_titles entry'
        : ` -- FLAGGED: birthday month (turns ${flag.ageTurned}), draft a segment_titles entry`
      : '';
    lines.push(`[${index}] ${segment.id} "${segment.label}" -- ${segment.memoryIds.length} memories${flagDesc}`);
  });
  lines.push('');

  lines.push('SPREAD CANDIDATES (topic / people-pair / emotion -- all compete equally for a place in the book):');
  if (candidates.length === 0) {
    lines.push('(none -- no candidate reached its minimum eligible-memory threshold in this scope)');
  }
  for (const candidate of candidates) {
    lines.push(
      `- candidate_id="${candidate.id}" [${candidate.kind}] ("${candidate.defaultTitle}") -- ${candidate.memoryIds.length} member memories: ${candidate.memoryIds.join(', ')}`,
    );
  }
  lines.push('');

  lines.push('MEMORIES (id | date | topics | emotion | hasText | excerpt | photos/videos/orientation | engagement | milestones | tagged people -- first name is the ONLY sanctioned source of relationship words, see RELATIONSHIP WORDS above; a "nn:" suffix is that person\'s OWN profile nickname(s) -- see PEOPLE-PAIR SPREAD TITLES AND NAMES IN COPY above, prefer it in generated copy):');
  for (const feature of [...features.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    const milestoneDesc = feature.milestones.map((m) => m.name).join(';') || '-';
    const excerpt = feature.excerpt ? feature.excerpt.replace(/\n/g, ' ') : '(no text)';
    const peopleDesc = feature.taggedMembers
      .map((m) => `${m.firstName}(${m.personType}${m.nicknames.length > 0 ? `;nn:${m.nicknames.join('/')}` : ''})`)
      .join(',') || '-';
    const orientationMarker = formatOrientationMarker(feature.photoOrientation);
    const assetDesc = `p${feature.photoCount}/v${feature.videoCount}${orientationMarker ? `/${orientationMarker}` : ''}`;
    lines.push(
      `${feature.id} | ${feature.date} | [${feature.topics.join(',')}] | ${feature.emotion ?? '-'} | ${feature.hasText ? 'y' : 'n'} | "${excerpt}" | ${assetDesc} | eng${feature.engagementCount} | ${milestoneDesc} | ${peopleDesc}`,
    );
  }

  return lines.join('\n');
}

/**
 * Request body for the outline chat call, as a plain object (exported for
 * direct unit testing, independent of the fetch plumbing). Deliberately
 * omits `temperature` and any token-cap param: reasoning-family models
 * (e.g. `gpt-5.6-sol`) reject a non-default `temperature` with a 400
 * `unsupported_value`, and separately require `max_completion_tokens`
 * instead of `max_tokens` if a cap is ever added -- neither classic nor
 * reasoning models need either field here, so the simplest fix is to send
 * neither and let every model use its own default. `response_format:
 * {type:'json_object'}` is supported by both families and stays.
 */
export function buildOutlineRequestBody(
  systemPrompt: string,
  userPrompt: string,
  model: string,
): Record<string, unknown> {
  return {
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };
}

// ── AI response parsing + validation (never trust the model -- plan §5) ────

export type SpreadTitleMode = 'quote' | 'descriptive';

export interface ParsedSpreadSelection {
  candidateId: string;
  candidateKind: CandidateKind;
  insertAfterSegmentIndex: number;
  title: string;
  /** A spread title is either a verbatim/lightly-trimmed `quote` lifted from
   * a member memory (code verifies it against that memory's real text --
   * see `isQuoteSupportedByContent`/`verifyQuoteTitles`), or a
   * `descriptive` title naming a concrete place/activity/object, which must
   * stay true of every memory in the spread. Defaults to 'descriptive' when
   * the model omits or garbles the field. */
  titleMode: SpreadTitleMode;
  /** Required (and validated to be one of this spread's OWN `memoryIds`)
   * when `titleMode` is 'quote'; downgraded to 'descriptive' + null with a
   * recorded violation otherwise. */
  titleSourceMemoryId: string | null;
  memoryIds: string[];
  rationale: Record<string, string>;
  /** A short thematic eyebrow line (antetítulo) above the title, journal
   * language, <=6 words -- design renders it in small caps. Themed spreads
   * only (never requested for months/firsts/birthday). Connective text,
   * editable later, never parent text. Null when the model omitted it -- a
   * kicker is optional, not every spread needs one. */
  kicker: string | null;
}

export interface ParsedBackboneHighlight {
  segmentId: string;
  memoryIds: string[];
  rationale: Record<string, string>;
}

export interface ParsedFirstsWarmName {
  memoryId: string;
  milestoneId: string;
  warmName: string;
}

export interface ParsedOutlineResponse {
  /** The model's own resolved BCP-47 code, validated + code-safety-netted
   * via `resolveOutlineLanguage` -- never the model's raw, unvalidated
   * string. Always a plausibly-BCP-47 value (falls back to the configured
   * language, then `FALLBACK_LANGUAGE`, when the model's own field is
   * missing or malformed -- a malformed, non-blank value also records an
   * `invalid_language` violation; a merely absent field does not, matching
   * this file's convention for other optional AI-drafted fields). */
  language: string;
  spreads: ParsedSpreadSelection[];
  backboneHighlights: ParsedBackboneHighlight[];
  /** The AI's journal-language draft of the Firsts spread's "big and small
   * victories this year" framing. Null when no Firsts spread was offered,
   * or the model didn't supply one -- callers fall back to
   * `FIRSTS_DEFAULT_TITLE`. */
  firstsTitle: string | null;
  /** Special birth/birthday backbone segment titles, keyed by the ORIGINAL
   * segment id the model saw. Only entries whose key was actually flagged
   * are ever used by the caller. */
  segmentTitles: Record<string, string>;
  /** Up to 5 book-wide candidates for a full-bleed page or the cover -- the
   * strongest single images of the year. Not scoped to any spread/segment,
   * validated only for existence in scope (see `parseOutlineResponse`). */
  heroCandidates: string[];
  /** Owner decision, 2026-08-31 (cover-safety fix, following two cover
   * failures traced to the renderer's blind first-photo fallback: a
   * hospital/medical shot, and a photo OF a child's drawing rather than the
   * child): up to `MAX_COVER_CANDIDATES` book-wide candidates for the
   * COVER specifically, ranked best-first, vision-judged against criteria
   * `hero_candidates` doesn't carry -- must actually show the child's face,
   * must not be a medical/hospital setting, must not be a photo of a
   * drawing/document/screen/artwork. May overlap `heroCandidates` (a memory
   * can be both). Validated only for existence in scope, same as
   * `hero_candidates` -- the renderer's own asset-kind/width check happens
   * downstream (see book-renderer/src/model/fitter.ts `buildCoverPages`). */
  coverCandidates: string[];
  /** EVERY qualifying book-wide candidate for a full double-page panorama
   * spread -- wide, scenic, no faces near center -- uncapped, ordered
   * best-first by the model (the renderer takes 1 + 1 per ~20 pages down
   * this list). May overlap `heroCandidates` (a memory can be both).
   * Validated for existence AND for being `wide`-orientation (a tall/
   * square photo can never span a 2:1 panorama; see
   * `parseOutlineResponse`); order is preserved as given, never re-sorted. */
  panoramaCandidates: string[];
  /** A 2-3 sentence dedication-page body addressed to the child, journal
   * language, connective text (same class as `kicker`/
   * `internalEditorialNote`). The body must NOT open with a salutation
   * ("Para X,") -- the printed page's own furniture supplies that greeting;
   * a model that still emits one duplicates it on the page. Null when the
   * model didn't supply one. */
  dedication: string | null;
  /** A one-line back-cover colophon, journal language, connective text.
   * Null when the model didn't supply one. Spine text and the closing
   * page's copy are deliberately NOT AI fields (deterministic furniture) --
   * never add them here. */
  backCoverLine: string | null;
  /** A curator's note for human review of the book's arc, INTERNAL ONLY --
   * never printed on any page. Every renderer must treat this as
   * review-artifact-only, same as a spread's `rationale`. */
  internalEditorialNote: string;
  /** One AI-drafted warm second-person rephrasing per milestone row in
   * scope (e.g. "Monta bicicleta sin pedales" -> "Aprendiste a montar
   * bicicleta sin pedales"), journal language -- connective text, editable
   * downstream, and NEVER alters the parent's own memory caption. Empty
   * when Firsts is absent from this book. */
  firstsWarmNames: ParsedFirstsWarmName[];
}

export interface OutlineIntegrityViolation {
  kind: string;
  detail: string;
}

function candidateKindFromId(candidateId: string): CandidateKind | null {
  if (candidateId.startsWith('topic:')) return 'topic';
  if (candidateId.startsWith('people:')) return 'people-pair';
  if (candidateId.startsWith('emotion:')) return 'emotion';
  return null;
}

const MAX_HERO_CANDIDATES = 5;
const MAX_COVER_CANDIDATES = 5;

/**
 * Shared parsing for the book-wide memory-id lists (`hero_candidates`,
 * `panorama_candidates`): validates existence, an optional extra predicate
 * (e.g. "must be photo-bearing"), dedupes (preserving first-seen order --
 * load-bearing for panorama's best-first contract), and records a
 * violation for anything dropped -- never silently. `cap: null` means
 * uncapped (no "too many" check, nothing sliced off); a numeric `cap`
 * requires `kinds.tooMany` and truncates + records a violation if exceeded.
 */
function parseCappedIdList(
  raw: unknown,
  validIds: Set<string>,
  cap: number | null,
  kinds: { unknown: string; tooMany?: string },
  violations: OutlineIntegrityViolation[],
  extra?: { check: (id: string) => boolean; failKind: string },
): string[] {
  const out: string[] = [];
  const rawList = Array.isArray(raw) ? raw : [];
  for (const id of rawList) {
    if (typeof id !== 'string' || !validIds.has(id)) {
      violations.push({ kind: kinds.unknown, detail: previewJson(id) });
      continue;
    }
    if (extra && !extra.check(id)) {
      violations.push({ kind: extra.failKind, detail: id });
      continue;
    }
    if (out.includes(id)) {
      violations.push({ kind: 'duplicate_memory_id', detail: id });
      continue;
    }
    out.push(id);
  }
  if (cap === null) return out;
  if (out.length > cap) {
    violations.push({ kind: kinds.tooMany!, detail: `${out.length} > ${cap}` });
  }
  return out.slice(0, cap);
}

function previewJson(value: unknown): string {
  try {
    const json = JSON.stringify(value) ?? String(value);
    return json.length > 80 ? `${json.slice(0, 80)}…` : json;
  } catch {
    return String(value);
  }
}

/**
 * Tolerant-but-traced parsing of the model's raw JSON (mirrors
 * eval-memory-book-tagging.ts's parseTopics: never silently drop something
 * unrecognized -- record it). Every `memory_ids` entry not in
 * `validMemoryIds`, every `candidate_id` not in `validCandidateIds`, and
 * every `segment_id` not in `validSegmentIds` is dropped and recorded as a
 * violation rather than trusted.
 */
export function parseOutlineResponse(
  raw: unknown,
  validCandidateIds: Set<string>,
  validSegmentIds: Set<string>,
  validMemoryIds: Set<string>,
  candidateMembersById: Map<string, Set<string>>,
  candidateDefaultTitleById: Map<string, string>,
  segmentMembersById: Map<string, Set<string>>,
  /** panorama candidates must be `wide` -- a tall/square/unknown-orientation
   * photo can never span a 2:1 double-page panorama, no matter how scenic. */
  wideOrientationMemoryIds: Set<string> = new Set(),
  /** `"<memoryId>::<milestoneId>"` keys for every real (memory, milestone)
   * pair in scope -- a `firsts_milestones` entry not matching one of these
   * is dropped and recorded, never trusted. */
  validMilestoneKeys: Set<string> = new Set(),
  /** `families.gallery_caption_language`, trimmed, `null` when unset/blank
   * -- the LANGUAGE resolution chain's step (2) fallback, fed to
   * `resolveOutlineLanguage` when the model's own `language` field is
   * missing or fails the loose BCP-47 check. */
  configuredLanguage: string | null = null,
): { response: ParsedOutlineResponse; violations: OutlineIntegrityViolation[] } {
  const violations: OutlineIntegrityViolation[] = [];
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  // LANGUAGE: parse + validate BEFORE anything else -- never trust the
  // model's raw string un-checked (same "never trust the model" posture as
  // every other field in this function). Mirrors this file's own
  // established convention for other AI-drafted-but-optional fields
  // (dedication/back_cover_line/firsts_title/kicker: absence alone is not a
  // violation, only a garbled/invalid VALUE is) -- a well-behaved model is
  // instructed this field is required, but a merely-absent field still
  // degrades gracefully via `resolveOutlineLanguage`'s own fallback chain
  // rather than being flagged as if it were malformed data.
  const rawLanguage = typeof obj.language === 'string' ? obj.language.trim() : '';
  const rawLanguageValid = rawLanguage.length > 0 && BCP47_PATTERN.test(rawLanguage);
  if (rawLanguage && !rawLanguageValid) {
    violations.push({ kind: 'invalid_language', detail: rawLanguage });
  }
  const language = resolveOutlineLanguage(rawLanguageValid ? rawLanguage : null, configuredLanguage);

  const spreadsRaw = Array.isArray(obj.spreads) ? obj.spreads : [];
  const spreads: ParsedSpreadSelection[] = [];

  for (const item of spreadsRaw) {
    if (!item || typeof item !== 'object') {
      violations.push({ kind: 'malformed_spread', detail: previewJson(item) });
      continue;
    }
    const o = item as Record<string, unknown>;
    const candidateId = typeof o.candidate_id === 'string' ? o.candidate_id : null;
    const candidateKind = candidateId ? candidateKindFromId(candidateId) : null;
    if (!candidateId || !candidateKind || !validCandidateIds.has(candidateId)) {
      violations.push({ kind: 'unknown_candidate_id', detail: String(candidateId) });
      continue;
    }

    const memberSet = candidateMembersById.get(candidateId) ?? new Set<string>();
    const rawIds = Array.isArray(o.memory_ids) ? o.memory_ids : [];
    const memoryIds: string[] = [];
    for (const id of rawIds) {
      if (typeof id !== 'string') {
        violations.push({ kind: 'malformed_memory_id', detail: previewJson(id) });
        continue;
      }
      if (!validMemoryIds.has(id)) {
        violations.push({ kind: 'unknown_memory_id', detail: id });
        continue;
      }
      if (!memberSet.has(id)) {
        violations.push({ kind: 'memory_not_in_candidate', detail: `${id} not a member of ${candidateId}` });
        continue;
      }
      if (memoryIds.includes(id)) {
        violations.push({ kind: 'duplicate_memory_id', detail: id });
        continue;
      }
      memoryIds.push(id);
    }

    const insertAfterSegmentIndex = typeof o.insert_after_segment_index === 'number'
      ? o.insert_after_segment_index
      : -1;

    const rationale: Record<string, string> = {};
    if (o.rationale && typeof o.rationale === 'object') {
      for (const [id, reason] of Object.entries(o.rationale as Record<string, unknown>)) {
        if (typeof reason === 'string' && memoryIds.includes(id)) rationale[id] = reason;
      }
    }

    const rawTitleMode = o.title_mode;
    let titleMode: SpreadTitleMode = 'descriptive';
    if (rawTitleMode === 'quote') {
      titleMode = 'quote';
    } else if (rawTitleMode !== undefined && rawTitleMode !== 'descriptive') {
      violations.push({ kind: 'invalid_title_mode', detail: `${candidateId}: ${previewJson(rawTitleMode)}` });
    }

    let titleSourceMemoryId: string | null = null;
    if (titleMode === 'quote') {
      const rawSourceId = typeof o.title_source_memory_id === 'string' ? o.title_source_memory_id : null;
      if (rawSourceId && memoryIds.includes(rawSourceId)) {
        titleSourceMemoryId = rawSourceId;
      } else {
        violations.push({
          kind: 'quote_missing_source',
          detail: `${candidateId}: title_source_memory_id "${String(rawSourceId)}" is not one of this spread's own memory_ids`,
        });
        titleMode = 'descriptive'; // Safe fallback -- never render a "quoted from" attribution with no real source.
      }
    }

    const kicker = typeof o.kicker === 'string' && o.kicker.trim() ? o.kicker.trim() : null;

    spreads.push({
      candidateId,
      candidateKind,
      insertAfterSegmentIndex,
      title: typeof o.title === 'string' && o.title.trim() ? o.title.trim() : (candidateDefaultTitleById.get(candidateId) ?? candidateId),
      titleMode,
      titleSourceMemoryId,
      memoryIds,
      rationale,
      kicker,
    });
  }

  const backboneHighlightsRaw = Array.isArray(obj.backbone_highlights) ? obj.backbone_highlights : [];
  const backboneHighlights: ParsedBackboneHighlight[] = [];

  for (const item of backboneHighlightsRaw) {
    if (!item || typeof item !== 'object') {
      violations.push({ kind: 'malformed_backbone_highlight', detail: previewJson(item) });
      continue;
    }
    const o = item as Record<string, unknown>;
    const segmentId = typeof o.segment_id === 'string' ? o.segment_id : null;
    if (!segmentId || !validSegmentIds.has(segmentId)) {
      violations.push({ kind: 'unknown_segment_id', detail: String(segmentId) });
      continue;
    }

    const segmentMemberSet = segmentMembersById.get(segmentId) ?? new Set<string>();
    const rawIds = Array.isArray(o.memory_ids) ? o.memory_ids : [];
    const memoryIds: string[] = [];
    for (const id of rawIds) {
      if (typeof id !== 'string' || !validMemoryIds.has(id)) {
        violations.push({ kind: 'unknown_memory_id', detail: previewJson(id) });
        continue;
      }
      if (!segmentMemberSet.has(id)) {
        violations.push({ kind: 'highlight_not_in_segment', detail: `${id} not a member of ${segmentId}` });
        continue;
      }
      if (memoryIds.includes(id)) {
        violations.push({ kind: 'duplicate_memory_id', detail: id });
        continue;
      }
      memoryIds.push(id);
    }

    const rationale: Record<string, string> = {};
    if (o.rationale && typeof o.rationale === 'object') {
      for (const [id, reason] of Object.entries(o.rationale as Record<string, unknown>)) {
        if (typeof reason === 'string' && memoryIds.includes(id)) rationale[id] = reason;
      }
    }

    backboneHighlights.push({ segmentId, memoryIds, rationale });
  }

  const internalEditorialNote = typeof obj.editorial_note === 'string' ? obj.editorial_note : '';
  const firstsTitle = typeof obj.firsts_title === 'string' && obj.firsts_title.trim() ? obj.firsts_title.trim() : null;

  // One warm second-person rephrasing per (memory, milestone) pair -- never
  // trust the model's own memory_id/milestone_id echo without checking it
  // against a REAL milestone row.
  const firstsMilestonesRaw = Array.isArray(obj.firsts_milestones) ? obj.firsts_milestones : [];
  const firstsWarmNames: ParsedFirstsWarmName[] = [];
  const seenFirstsMilestoneKeys = new Set<string>();
  for (const item of firstsMilestonesRaw) {
    if (!item || typeof item !== 'object') {
      violations.push({ kind: 'malformed_firsts_milestone', detail: previewJson(item) });
      continue;
    }
    const o = item as Record<string, unknown>;
    const memoryId = typeof o.memory_id === 'string' ? o.memory_id : null;
    const milestoneId = typeof o.milestone_id === 'string' ? o.milestone_id : null;
    const key = `${memoryId}::${milestoneId}`;
    if (!memoryId || !milestoneId || !validMilestoneKeys.has(key)) {
      violations.push({ kind: 'unknown_firsts_milestone', detail: key });
      continue;
    }
    const warmName = typeof o.warm_name === 'string' && o.warm_name.trim() ? o.warm_name.trim() : null;
    if (!warmName) {
      violations.push({ kind: 'missing_firsts_warm_name', detail: key });
      continue;
    }
    if (seenFirstsMilestoneKeys.has(key)) {
      violations.push({ kind: 'duplicate_firsts_milestone', detail: key });
      continue;
    }
    seenFirstsMilestoneKeys.add(key);
    firstsWarmNames.push({ memoryId, milestoneId, warmName });
  }

  const segmentTitles: Record<string, string> = {};
  if (obj.segment_titles && typeof obj.segment_titles === 'object') {
    for (const [segmentId, title] of Object.entries(obj.segment_titles as Record<string, unknown>)) {
      if (!validSegmentIds.has(segmentId)) {
        violations.push({ kind: 'unknown_segment_id', detail: segmentId });
        continue;
      }
      if (typeof title === 'string' && title.trim()) segmentTitles[segmentId] = title.trim();
    }
  }

  const heroCandidates = parseCappedIdList(
    obj.hero_candidates,
    validMemoryIds,
    MAX_HERO_CANDIDATES,
    { unknown: 'unknown_hero_candidate', tooMany: 'too_many_hero_candidates' },
    violations,
  );

  // Owner decision, 2026-08-31 (cover-safety fix): same shape as
  // hero_candidates -- existence-only validation, the renderer's own
  // asset-kind/width check happens downstream. See the field's own doc
  // comment on `ParsedOutlineResponse.coverCandidates`.
  const coverCandidates = parseCappedIdList(
    obj.cover_candidates,
    validMemoryIds,
    MAX_COVER_CANDIDATES,
    { unknown: 'unknown_cover_candidate', tooMany: 'too_many_cover_candidates' },
    violations,
  );

  // Owner amendment, 2026-08-27: panorama nomination is UNCAPPED (`cap:
  // null`) -- the renderer paces itself off the best-first ordering, so
  // nomination should never be the bottleneck. Order is preserved exactly
  // as the model returned it (never re-sorted).
  const panoramaCandidates = parseCappedIdList(
    obj.panorama_candidates,
    validMemoryIds,
    null,
    { unknown: 'unknown_panorama_candidate' },
    violations,
    { check: (id) => wideOrientationMemoryIds.has(id), failKind: 'panorama_candidate_not_wide' },
  );

  const dedication = typeof obj.dedication === 'string' && obj.dedication.trim() ? obj.dedication.trim() : null;
  const backCoverLine = typeof obj.back_cover_line === 'string' && obj.back_cover_line.trim() ? obj.back_cover_line.trim() : null;

  return {
    response: {
      language,
      spreads,
      backboneHighlights,
      firstsTitle,
      segmentTitles,
      heroCandidates,
      coverCandidates,
      panoramaCandidates,
      dedication,
      backCoverLine,
      internalEditorialNote,
      firstsWarmNames,
    },
    violations,
  };
}

// ── Quote-title verification (owner amendment, round-2, 2026-08-25: "never
// silently accept an unverifiable quote -- a fabricated quote would violate
// the parent-text-is-sacred rule") ──────────────────────────────────────

/** Lowercases, strips diacritics, and collapses everything but letters/digits
 * to single spaces -- a deliberately coarse normalization so a lightly
 * trimmed/re-punctuated quote (the plan's own phrasing: "verbatim or
 * lightly trimmed") still matches, while a title that doesn't appear in the
 * source text AT ALL still fails. */
export function normalizeForQuoteCheck(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function isQuoteSupportedByContent(title: string, sourceContent: string | null): boolean {
  if (!sourceContent) return false;
  const normalizedTitle = normalizeForQuoteCheck(title);
  if (!normalizedTitle) return false;
  return normalizeForQuoteCheck(sourceContent).includes(normalizedTitle);
}

export interface QuoteTitleCheckInput {
  candidateId: string;
  title: string;
  titleMode: SpreadTitleMode;
  titleSourceMemoryId: string | null;
}

/**
 * Code-verifies every `quote`-mode spread title against its declared source
 * memory's REAL text (never the model's word for it) -- on failure the
 * title is NOT discarded (the caller still uses it; "keep the title in the
 * eval artifact but flag it") but a violation is recorded so a fabricated
 * quote is never silently presented as real. `contentByMemoryId` should
 * hold full `memories.content`, not the 120-char excerpt.
 */
export function verifyQuoteTitles(
  spreads: QuoteTitleCheckInput[],
  contentByMemoryId: Map<string, string | null>,
): OutlineIntegrityViolation[] {
  const violations: OutlineIntegrityViolation[] = [];
  for (const spread of spreads) {
    if (spread.titleMode !== 'quote') continue;
    const sourceContent = spread.titleSourceMemoryId ? contentByMemoryId.get(spread.titleSourceMemoryId) ?? null : null;
    if (!isQuoteSupportedByContent(spread.title, sourceContent)) {
      violations.push({
        kind: 'unverifiable_quote_title',
        detail: `${spread.candidateId}: "${spread.title}" not found in source memory ${spread.titleSourceMemoryId ?? '(none)'}`,
      });
    }
  }
  return violations;
}

// ── Cover-candidate verification pass (owner decision, 2026-09-01: a
// dedicated vision judge to catch what the embedded COVER CANDIDATES prompt
// rules alone did not). `parseOutlineResponse`'s `coverCandidates` above are
// nominated by the SAME text-only call that curates the rest of the outline
// (see `buildOutlineRequestBody` -- no images are ever attached there), so
// the model is judging the disqualification checklist BLIND, from topics/
// labels/description text alone. Live finding across two real books: that
// text-only judgment violated its own stated rules both times -- a photo OF
// a framed painting ranked #1 for one book (an unmissable gilded frame in
// the thumb), a two-panel collage with a visible seam ranked #1 for
// another. "Adorable baby" bias beat the embedded rules; the prompt wording
// was already at its ceiling. The fix is generate-then-verify: ONE
// additional vision call, after the main call, whose ONLY job is that same
// checklist, asked narrowly, against the REAL thumbnails, with nothing else
// competing for the model's attention -- see the eval script's
// `verifyCoverCandidates` (IO orchestration -- fetches thumbnails, calls
// OpenAI, stays there), which is built from the pure pieces below. ─────────

/** Fixed enum for `reason_code` -- the model must pick one of these, never
 * invent a new one (see `parseCoverVerifyResponse`). `'ok'` is reserved for
 * a non-disqualified verdict. */
export type CoverVerifyReasonCode =
  | 'ok'
  | 'not_child_photo'
  | 'medical_setting'
  | 'photo_of_artwork_or_document'
  | 'collage_or_multi_panel';

const COVER_VERIFY_REASON_CODES: ReadonlySet<string> = new Set<CoverVerifyReasonCode>([
  'ok',
  'not_child_photo',
  'medical_setting',
  'photo_of_artwork_or_document',
  'collage_or_multi_panel',
]);

export interface CoverVerifyVerdict {
  /** Position in the image list SENT to the model -- never a memory id; the
   * system prompt labels candidates by index only, and the index -> id
   * mapping lives in code (the eval script's `verifyCoverCandidates`'s
   * `indexToId`), never handed to the model as an unearned shortcut. */
  index: number;
  disqualified: boolean;
  reasonCode: CoverVerifyReasonCode;
  /** Short free-text detail alongside the enum -- a plain description of
   * what the judge saw, never trusted alone (the enum is what code branches
   * on), and defensively length-capped. */
  reasonDetail: string;
}

/**
 * System prompt for the verify call -- ONLY the disqualification checklist,
 * verbatim in spirit from the COVER CANDIDATES rules in
 * `buildOutlineSystemPrompt` above, deliberately re-asked as its OWN
 * narrower prompt (see the section comment above for why) rather than
 * reusing the outline prompt verbatim.
 */
export function buildCoverVerifySystemPrompt(): string {
  return [
    "You are a strict safety judge for the COVER of a premium printed baby/family memory book -- the first thing anyone sees, with its own stricter bar than an ordinary page. You are shown a numbered list of candidate cover photos, labeled by INDEX ONLY. For EACH index, decide whether it is DISQUALIFIED, using ONLY these rules:",
    '',
    '(a) NOT an actual photograph that features the child WITH THEIR FACE VISIBLE -- not a video frame, not a screenshot, not one where the face is hidden, turned away, or out of frame.',
    '(b) A MEDICAL OR HOSPITAL SETTING -- visible medical equipment, a procedure in progress, or an unclothed newborn in a clinical context -- even if the image is technically sharp and well-composed.',
    '(c) A PHOTO OF A DRAWING, DOCUMENT, SCREEN, OR OTHER ARTWORK -- including a photo where the child appears only INSIDE framed or printed artwork (a photo of a framed painting or printed portrait OF the child is a photo of an object, not of the child).',
    '(d) A COLLAGE, DIPTYCH, MULTI-PANEL, OR SIDE-BY-SIDE COMPOSITE -- any visible seam or panel boundary disqualifies the image no matter how good each panel is.',
    '',
    "When uncertain whether a rule applies, DISQUALIFY -- the fallback path is safe (the renderer has its own fallback cover selection), so a false disqualification costs nothing, while a false pass could print an unacceptable cover.",
    '',
    'Return STRICT JSON: {"verdicts": [{"index": <int>, "disqualified": <bool>, "reason_code": "<ok|not_child_photo|medical_setting|photo_of_artwork_or_document|collage_or_multi_panel>", "reason_detail": "<one short phrase, <=15 words, plain description of what you saw>"}, ...]} -- exactly one entry per index shown to you. Use "ok" only when disqualified is false. Never use a reason_code outside that fixed list.',
  ].join('\n');
}

export function buildCoverVerifyUserText(candidateCount: number): string {
  return `${candidateCount} numbered candidate cover photo(s) follow, index 0 through ${candidateCount - 1}, in that order. Judge each against the checklist in the system prompt and return your verdicts JSON -- one entry per index.`;
}

export interface CoverVerifyImageInput {
  index: number;
  base64: string;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
}

/**
 * Request body for the verify call, as a plain object (exported for direct
 * unit testing, same convention as `buildOutlineRequestBody`). Candidates
 * are labeled by INDEX in the accompanying text/image sequence, never by
 * memory id -- see `CoverVerifyVerdict.index`'s doc comment.
 */
export function buildCoverVerifyRequestBody(
  systemPrompt: string,
  userText: string,
  images: CoverVerifyImageInput[],
  model: string,
): Record<string, unknown> {
  const userContent: Array<Record<string, unknown>> = [{ type: 'text', text: userText }];
  for (const image of images) {
    userContent.push({ type: 'text', text: `Index ${image.index}:` });
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:${image.contentType};base64,${image.base64}`, detail: 'high' },
    });
  }
  return {
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  };
}

/**
 * Defensive parse of the verify call's raw JSON (never trust the model,
 * same posture as `parseOutlineResponse`) -- but WHOLE-RESPONSE fail-open,
 * not per-field: any structural problem (not an object, `verdicts` missing
 * or the wrong length, a duplicate or out-of-range `index`, a non-boolean
 * `disqualified`, an unrecognized `reason_code`, a non-string
 * `reason_detail`) discards the ENTIRE response rather than trusting a
 * partially-sane parse. The caller's contract for `null` is "keep ALL
 * candidates" -- partial trust here would risk dropping a real candidate on
 * the strength of a verdict that was itself malformed.
 */
export function parseCoverVerifyResponse(raw: unknown, candidateCount: number): CoverVerifyVerdict[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const rawList = (raw as Record<string, unknown>).verdicts;
  if (!Array.isArray(rawList) || rawList.length !== candidateCount) return null;

  const byIndex = new Map<number, CoverVerifyVerdict>();
  for (const item of rawList) {
    if (!item || typeof item !== 'object') return null;
    const entry = item as Record<string, unknown>;
    const index = entry.index;
    const disqualified = entry.disqualified;
    const reasonCode = entry.reason_code;
    const reasonDetail = entry.reason_detail;

    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= candidateCount) return null;
    if (byIndex.has(index)) return null;
    if (typeof disqualified !== 'boolean') return null;
    if (typeof reasonCode !== 'string' || !COVER_VERIFY_REASON_CODES.has(reasonCode)) return null;
    if (typeof reasonDetail !== 'string') return null;

    byIndex.set(index, {
      index,
      disqualified,
      reasonCode: reasonCode as CoverVerifyReasonCode,
      reasonDetail: reasonDetail.trim().slice(0, 200),
    });
  }
  if (byIndex.size !== candidateCount) return null;
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/**
 * Pure "apply the verdicts" step, factored out so both the eval script's
 * `verifyCoverCandidates` AND unit tests can exercise this decision in
 * isolation, without any network/R2 plumbing:
 * - `verdicts === null` (the verify call failed, or its response was
 *   unparseable) FAILS OPEN -- every original candidate is kept, in its
 *   original order, and a single `cover_verify_unparseable` violation is
 *   recorded.
 * - Otherwise, every disqualified verdict's candidate is dropped (best-
 *   first order preserved among the survivors) and recorded as its own
 *   `cover_candidate_disqualified` violation with the id + reason. When
 *   every candidate is disqualified, the result is `[]` -- by design, the
 *   renderer's own legacy/fallback cover selection handles that case (see
 *   the COVER CANDIDATES prompt rule: "never nominate a disqualified image
 *   just to avoid an empty list").
 */
export function applyCoverVerifyVerdicts(
  candidateIds: string[],
  indexToId: Map<number, string>,
  verdicts: CoverVerifyVerdict[] | null,
): { coverCandidates: string[]; violations: OutlineIntegrityViolation[] } {
  const violations: OutlineIntegrityViolation[] = [];
  if (!verdicts) {
    violations.push({
      kind: 'cover_verify_unparseable',
      detail: `verify response did not parse for ${indexToId.size} judged candidate(s) of ${candidateIds.length} nominated; kept all`,
    });
    return { coverCandidates: candidateIds, violations };
  }

  const disqualifiedIds = new Set<string>();
  for (const verdict of verdicts) {
    if (!verdict.disqualified) continue;
    const id = indexToId.get(verdict.index);
    if (!id) continue; // defensive -- parseCoverVerifyResponse already bounds index to [0, indexToId.size), so unreachable in practice.
    disqualifiedIds.add(id);
    violations.push({
      kind: 'cover_candidate_disqualified',
      detail: `${id} (${verdict.reasonCode}: ${verdict.reasonDetail})`,
    });
  }

  return { coverCandidates: candidateIds.filter((id) => !disqualifiedIds.has(id)), violations };
}
