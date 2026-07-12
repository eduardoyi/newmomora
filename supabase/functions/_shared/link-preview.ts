// Inline links (docs/plans/inline-links.md): URL extraction, SSRF-guarded
// title fetching, and prompt sanitization shared by fetch-link-previews and
// the AI pipeline (analyze-emotion, generate-illustration). Deno-only -- see
// src/utils/links.ts for the client mirror (extraction/formatting only, no
// fetching).

// Matches both here and in src/utils/links.ts must stay identical: greedy
// http(s) URL match, then trailing punctuation/ellipsis trimmed off. A
// missed exotic URL just stays plain text -- deliberately conservative.
const TRAILING_PUNCTUATION_REGEX = /[.,;:!?)\]}"'…]+$/;

function urlMatchPattern(): RegExp {
  return /https?:\/\/\S+/g;
}

function stripTrailingPunctuation(url: string): string {
  return url.replace(TRAILING_PUNCTUATION_REGEX, '');
}

export function extractUrls(text: string | null | undefined): string[] {
  if (!text) {
    return [];
  }

  const matches = text.match(urlMatchPattern()) ?? [];
  return matches.map(stripTrailingPunctuation).filter((url) => url.length > 0);
}

/** For AI prompts: strip URLs entirely and collapse the resulting whitespace. */
export function stripUrls(text: string | null | undefined): string {
  if (!text) {
    return '';
  }

  return text.replace(urlMatchPattern(), ' ').replace(/\s+/g, ' ').trim();
}

// ── SSRF guard, layer 1: hostname rules (sync) ──────────────────────────────
// Reject IP-literal hosts entirely (v4/v6, including bracketed forms) plus
// localhost/*.local/*.internal. Uses the WHATWG URL parser's `hostname`
// (never a string regex on the raw URL) so decimal/octal/hex IPv4 encodings
// are already normalized to dotted-quad by the time we look at them.
const BLOCKED_HOSTNAME_SUFFIXES = ['.local', '.internal'];

function stripBrackets(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function isIpLiteralHostname(hostname: string): boolean {
  const normalized = stripBrackets(hostname);
  if (normalized.includes(':')) {
    return true; // IPv6 literal
  }
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(normalized);
}

export function isFetchableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  if (parsed.username || parsed.password) {
    return false;
  }

  // URL.port is '' when the port matches the scheme's default (or is
  // omitted); anything else is a non-default port.
  if (parsed.port !== '') {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();

  if (!hostname || hostname === 'localhost') {
    return false;
  }

  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return false;
  }

  if (isIpLiteralHostname(hostname)) {
    return false;
  }

  return true;
}

// ── SSRF guard, layer 2: DNS resolution (async) ─────────────────────────────
// Layer 1 alone doesn't stop an innocuous-looking domain whose A/AAAA record
// points at a private or metadata IP. Resolve before fetching and reject if
// any resolved address is loopback/private/link-local/metadata/unspecified,
// including IPv4-mapped IPv6 forms of those. Known limitation: the window
// between this resolve and the actual fetch is a residual TOCTOU/DNS-rebind
// gap -- accepted (single fetch, no attacker-observable timing loop, and the
// Supabase Edge runtime is isolated).

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return null;
  }

  let result = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return null;
    }
    result = (result << 8) | value;
  }

  return result >>> 0;
}

function ipv4InRange(ip: number, base: string, maskBits: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) {
    return false;
  }

  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
  return (ip & mask) === (baseInt & mask);
}

export function isPrivateIPv4(address: string): boolean {
  const value = ipv4ToInt(address);
  if (value === null) {
    return false;
  }

  return (
    value === 0 || // 0.0.0.0 unspecified
    ipv4InRange(value, '127.0.0.0', 8) || // loopback
    ipv4InRange(value, '10.0.0.0', 8) || // private
    ipv4InRange(value, '172.16.0.0', 12) || // private
    ipv4InRange(value, '192.168.0.0', 16) || // private
    ipv4InRange(value, '169.254.0.0', 16) // link-local incl. 169.254.169.254 metadata
  );
}

/** Parses a (possibly compressed) IPv6 address string into 8 16-bit groups. */
function parseIPv6Groups(address: string): number[] | null {
  const lower = stripBrackets(address).toLowerCase();

  let head = lower;
  let v4Tail: number[] | null = null;

  const v4Match = lower.match(/(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Match) {
    const octets = v4Match[1].split('.').map(Number);
    if (octets.length !== 4 || octets.some((octet) => octet < 0 || octet > 255)) {
      return null;
    }
    v4Tail = octets;
    head = lower.slice(0, lower.length - v4Match[1].length).replace(/:$/, '');
  }

  const sides = head.split('::');
  if (sides.length > 2) {
    return null;
  }

  const parseGroups = (segment: string): number[] | null => {
    if (segment.length === 0) {
      return [];
    }
    const groups = segment.split(':').map((group) => parseInt(group, 16));
    return groups.some((group) => Number.isNaN(group) || group < 0 || group > 0xffff)
      ? null
      : groups;
  };

  let groups: number[];

  if (sides.length === 2) {
    const left = parseGroups(sides[0]);
    const right = parseGroups(sides[1]);
    if (!left || !right) {
      return null;
    }
    const knownCount = left.length + right.length + (v4Tail ? 2 : 0);
    const missing = 8 - knownCount;
    if (missing < 0) {
      return null;
    }
    groups = [...left, ...new Array(missing).fill(0), ...right];
  } else {
    const parsed = parseGroups(head);
    if (!parsed) {
      return null;
    }
    groups = parsed;
  }

  if (v4Tail) {
    groups = [...groups, (v4Tail[0] << 8) | v4Tail[1], (v4Tail[2] << 8) | v4Tail[3]];
  }

  return groups.length === 8 ? groups : null;
}

export function isPrivateIPv6(address: string): boolean {
  const groups = parseIPv6Groups(address);
  if (!groups) {
    return false;
  }

  if (groups.every((group) => group === 0)) {
    return true; // :: unspecified
  }

  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return true; // ::1 loopback
  }

  const first = groups[0];

  if ((first & 0xfe00) === 0xfc00) {
    return true; // fc00::/7 unique local (top 7 bits fixed -> first byte 0xfc or 0xfd)
  }

  if ((first & 0xffc0) === 0xfe80) {
    return true; // fe80::/10 link-local
  }

  // IPv4-mapped ::ffff:a.b.c.d
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const octets = [
      (groups[6] >> 8) & 0xff,
      groups[6] & 0xff,
      (groups[7] >> 8) & 0xff,
      groups[7] & 0xff,
    ];
    return isPrivateIPv4(octets.join('.'));
  }

  return false;
}

function isBlockedResolvedAddress(address: string): boolean {
  return address.includes(':') ? isPrivateIPv6(address) : isPrivateIPv4(address);
}

/**
 * Resolves `hostname` via A/AAAA lookups and reports whether any resolved
 * address is loopback/private/link-local/metadata/unspecified. Per-type DNS
 * failures are tolerated (e.g. AAAA-only or A-only hosts); if BOTH lookups
 * fail, the host is treated as unfetchable (the subsequent fetch would fail
 * anyway, and there's nothing safe to resolve against).
 */
export async function resolvesToBlockedAddress(hostname: string): Promise<boolean> {
  const [aResult, aaaaResult] = await Promise.allSettled([
    Deno.resolveDns(hostname, 'A'),
    Deno.resolveDns(hostname, 'AAAA'),
  ]);

  const addresses: string[] = [];
  if (aResult.status === 'fulfilled') {
    addresses.push(...aResult.value);
  }
  if (aaaaResult.status === 'fulfilled') {
    addresses.push(...aaaaResult.value);
  }

  if (addresses.length === 0) {
    return true;
  }

  return addresses.some(isBlockedResolvedAddress);
}

/** Full SSRF guard: layer 1 (sync hostname rules) + layer 2 (DNS resolution). */
export async function isSafeToFetch(url: string): Promise<boolean> {
  if (!isFetchableUrl(url)) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  return !(await resolvesToBlockedAddress(parsed.hostname));
}

// ── Title parsing ────────────────────────────────────────────────────────
const OG_TITLE_META_REGEX = /<meta[^>]+property\s*=\s*["']og:title["'][^>]*>/i;
const CONTENT_ATTR_REGEX = /content\s*=\s*["']([^"']*)["']/i;
const TITLE_TAG_REGEX = /<title[^>]*>([\s\S]*?)<\/title>/i;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const code = isHex ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      const isValidUnicodeScalar =
        Number.isInteger(code) &&
        code >= 0 &&
        code <= 0x10ffff &&
        !(code >= 0xd800 && code <= 0xdfff);

      return isValidUnicodeScalar ? String.fromCodePoint(code) : match;
    }

    const replacement = NAMED_ENTITIES[entity];
    return replacement ?? match;
  });
}

// ASCII control chars (\x00-\x1F, \x7F) EXCLUDING \t/\n/\r (left for the
// whitespace-collapse step below so words don't get glued together) +
// Unicode bidi/format control chars (\u202A-\u202E, \u2066-\u2069) -- a
// hostile page title could otherwise visually reorder the rendered span.
// deno-lint-ignore no-control-regex
const CONTROL_CHARS_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u202A-\u202E\u2066-\u2069]/g;
const MAX_TITLE_LENGTH = 200;

export function cleanTitle(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }

  const decoded = decodeHtmlEntities(raw);
  const stripped = decoded.replace(CONTROL_CHARS_REGEX, '');
  const collapsed = stripped.replace(/\s+/g, ' ').trim();

  if (!collapsed) {
    return null;
  }

  return collapsed.length > MAX_TITLE_LENGTH ? collapsed.slice(0, MAX_TITLE_LENGTH) : collapsed;
}

export function parseHtmlTitle(html: string): string | null {
  const ogMatch = html.match(OG_TITLE_META_REGEX);
  if (ogMatch) {
    const contentMatch = ogMatch[0].match(CONTENT_ATTR_REGEX);
    const cleaned = cleanTitle(contentMatch?.[1]);
    if (cleaned) {
      return cleaned;
    }
  }

  const titleMatch = html.match(TITLE_TAG_REGEX);
  return cleanTitle(titleMatch?.[1]);
}

// ── Fetch orchestration ─────────────────────────────────────────────────
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 128 * 1024;

type HopResult =
  | { kind: 'redirect'; location: string | null }
  | { kind: 'failed' }
  | { kind: 'html'; html: string };

async function safeCancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort -- the response is being discarded either way.
  }
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return await response.text();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
        received += value.byteLength;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Best effort.
    }
  }

  const combined = new Uint8Array(Math.min(received, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const remaining = combined.length - offset;
    if (remaining <= 0) {
      break;
    }
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    combined.set(slice, offset);
    offset += slice.length;
  }

  return new TextDecoder().decode(combined);
}

// Single hop: fetch, then classify as redirect / failed / html. The abort
// timer stays live through body consumption (cleared only in `finally`) so
// the 5s budget covers headers *and* body, not just the initial connect.
async function fetchHop(url: string): Promise<HopResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,*/*;q=0.8',
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await safeCancelBody(response);
      return { kind: 'redirect', location };
    }

    if (!response.ok) {
      await safeCancelBody(response);
      return { kind: 'failed' };
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) {
      await safeCancelBody(response);
      return { kind: 'failed' };
    }

    const html = await readBodyCapped(response, MAX_BODY_BYTES);
    return { kind: 'html', html };
  } catch {
    return { kind: 'failed' };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetches a page title for `initialUrl`, re-running the full SSRF guard on
 * the initial URL and every redirect hop (max 3). Any failure -- blocked
 * host, timeout, non-HTML response, network error -- resolves to `null`;
 * this never throws for a single bad URL.
 */
export async function fetchPageTitle(initialUrl: string): Promise<string | null> {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await isSafeToFetch(currentUrl))) {
      return null;
    }

    const result = await fetchHop(currentUrl);

    if (result.kind === 'failed') {
      return null;
    }

    if (result.kind === 'html') {
      return parseHtmlTitle(result.html);
    }

    if (!result.location || hop === MAX_REDIRECTS) {
      return null;
    }

    try {
      currentUrl = new URL(result.location, currentUrl).toString();
    } catch {
      return null;
    }
  }

  return null;
}
