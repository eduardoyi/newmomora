// Year Film "line of the year / month" quote pick (docs/plans/year-film.md
// §5 scene 4, §7.2 step 3). Pure: prompt building, response parsing and
// verification. The fetch lives with the caller (eval script now, the
// Workflow in P1).
//
// The model only *selects*: every returned quote must be a verbatim
// substring of its memory's real text (isQuoteSupportedByContent, the
// book's quote-title rule) and attributed to one of the named children.
// Anything else is rejected and reported, never rendered.
import { isQuoteSupportedByContent } from './memory-book-outline.ts';
import type { VerifiedQuote } from './year-film-script.ts';
import { hasQuotedSpeech, isQuotePoolText } from './year-film-eligibility.ts';

export const QUOTE_POOL_MAX = 150;
export const QUOTE_TEXT_MAX_CHARS = 400;
export const QUOTE_MAX_CHARS = 90;
export const QUOTE_MAX_WORDS = 14;
export const QUOTES_REQUESTED = 5;

export interface QuoteSubject {
  id: string;
  name: string;
}

export interface QuotePoolMemory {
  id: string;
  date: string;
  text: string | null;
  taggedMemberIds: string[];
}

/** Memories worth sending: long enough text, tagged to a subject; explicit
 * quoted speech first, then newest first. */
export function selectQuotePool<T extends QuotePoolMemory>(memories: T[], subjects: QuoteSubject[]): T[] {
  const ids = new Set(subjects.map((s) => s.id));
  return memories
    .filter((m) => isQuotePoolText(m.text) && m.taggedMemberIds.some((id) => ids.has(id)))
    .sort(
      (a, b) =>
        Number(hasQuotedSpeech(b.text)) - Number(hasQuotedSpeech(a.text)) ||
        b.date.localeCompare(a.date) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, QUOTE_POOL_MAX);
}

export function buildQuotePrompt(
  subjects: QuoteSubject[],
  memories: QuotePoolMemory[],
): { system: string; user: string } {
  const names = subjects.map((s) => s.name).join(', ');
  const system = [
    'You pick quotes for a short family recap film.',
    `Find things that ${names} actually SAID OUT LOUD, written down by their parent in these journal entries.`,
    'Rules:',
    '- Copy the words EXACTLY as they appear in the entry (same language, same spelling, including the child\'s mispronunciations). Never translate, paraphrase, fix grammar or combine sentences. Code rejects anything that is not a verbatim substring.',
    '- Only the child\'s own spoken words — never the parent\'s narration, never words said by another person, never a description of what the child did.',
    `- Short: at most ${QUOTE_MAX_WORDS} words. Drop surrounding quotation marks.`,
    '- Prefer funny, sweet, surprising or very characteristic lines — the kind a parent would want on screen. Skip routine phrases ("more water", "no").',
    '- If an entry mentions several children, attribute the quote only if the entry makes clear who said it.',
    `- Return up to ${QUOTES_REQUESTED}, best first. Return an empty list if there is nothing good — that is fine.`,
    '- Also report "language": the BCP-47 code of the language most entries are written in (e.g. "es", "en"). The film is shown in that language.',
    'Respond with JSON: {"language":"<bcp47>","quotes":[{"memory_id":"...","speaker":"<one of the names>","quote":"..."}]}',
  ].join('\n');
  const user = memories
    .map((m) => {
      const text = (m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, QUOTE_TEXT_MAX_CHARS);
      return `[${m.id}] ${m.date}: ${text}`;
    })
    .join('\n');
  return { system, user: `Children: ${names}\n\nEntries:\n${user}` };
}

/** Picks the verbatim line of the year (owner, 2026-09-28: GPT-6 Sol). */
export const QUOTE_MODEL = 'gpt-6-sol';

export function buildQuoteRequestBody(system: string, user: string, model: string): Record<string, unknown> {
  return {
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
}

export interface QuoteRejection {
  memoryId: string | null;
  quote: string | null;
  reason: 'bad_shape' | 'unknown_memory' | 'unknown_speaker' | 'too_long' | 'not_verbatim' | 'duplicate';
}

/** Parses and verifies the model's JSON. Never throws on model output. */
export function parseQuoteResponse(
  raw: string,
  subjects: QuoteSubject[],
  contentById: Map<string, string | null>,
): { accepted: VerifiedQuote[]; rejected: QuoteRejection[]; language: string | null } {
  const accepted: VerifiedQuote[] = [];
  const rejected: QuoteRejection[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { accepted, rejected: [{ memoryId: null, quote: null, reason: 'bad_shape' }], language: null };
  }
  const rawLanguage = (parsed as { language?: unknown })?.language;
  const language = typeof rawLanguage === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(rawLanguage.trim())
    ? rawLanguage.trim()
    : null;
  const list = (parsed as { quotes?: unknown })?.quotes;
  if (!Array.isArray(list)) return { accepted, rejected: [{ memoryId: null, quote: null, reason: 'bad_shape' }], language };

  const byName = new Map(subjects.map((s) => [s.name.trim().toLowerCase(), s.id]));
  const seen = new Set<string>();
  for (const item of list) {
    const memoryId = typeof item?.memory_id === 'string' ? item.memory_id : null;
    const quote = typeof item?.quote === 'string' ? item.quote.trim().replace(/^["“«„']+|["”»“']+$/g, '').trim() : null;
    const speaker = typeof item?.speaker === 'string' ? item.speaker.trim().toLowerCase() : null;
    if (!memoryId || !quote || !speaker) {
      rejected.push({ memoryId, quote, reason: 'bad_shape' });
      continue;
    }
    if (!contentById.has(memoryId)) {
      rejected.push({ memoryId, quote, reason: 'unknown_memory' });
      continue;
    }
    const speakerId = byName.get(speaker);
    if (!speakerId) {
      rejected.push({ memoryId, quote, reason: 'unknown_speaker' });
      continue;
    }
    if (quote.length > QUOTE_MAX_CHARS || quote.split(/\s+/).length > QUOTE_MAX_WORDS) {
      rejected.push({ memoryId, quote, reason: 'too_long' });
      continue;
    }
    if (!isQuoteSupportedByContent(quote, contentById.get(memoryId) ?? null)) {
      rejected.push({ memoryId, quote, reason: 'not_verbatim' });
      continue;
    }
    const key = quote.toLowerCase();
    if (seen.has(key)) {
      rejected.push({ memoryId, quote, reason: 'duplicate' });
      continue;
    }
    seen.add(key);
    accepted.push({ memoryId, quote, speakerId });
  }
  return { accepted, rejected, language };
}
