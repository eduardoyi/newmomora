import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import {
  cleanTitle,
  extractUrls,
  fetchPageTitle,
  isFetchableUrl,
  isPrivateIPv4,
  isPrivateIPv6,
  isSafeToFetch,
  parseHtmlTitle,
  resolvesToBlockedAddress,
  stripUrls,
} from './link-preview.ts';

// ── extractUrls ──────────────────────────────────────────────────────────

Deno.test('extractUrls finds a single URL', () => {
  assertEquals(extractUrls('Check out https://example.com for more'), ['https://example.com']);
});

Deno.test('extractUrls strips trailing punctuation', () => {
  assertEquals(extractUrls('See https://example.com/path.'), ['https://example.com/path']);
  assertEquals(extractUrls('Cool link (https://example.com)!'), ['https://example.com']);
  assertEquals(extractUrls('Wow https://example.com…'), ['https://example.com']);
  assertEquals(extractUrls('Nested? https://example.com/a,b;c:d!'), ['https://example.com/a,b;c:d']);
});

Deno.test('extractUrls finds multiple URLs', () => {
  const text = 'First https://a.com then https://b.com/x?y=1';
  assertEquals(extractUrls(text), ['https://a.com', 'https://b.com/x?y=1']);
});

Deno.test('extractUrls returns empty array for no-URL text', () => {
  assertEquals(extractUrls('Just a regular memory about the park.'), []);
  assertEquals(extractUrls(''), []);
  assertEquals(extractUrls(null), []);
  assertEquals(extractUrls(undefined), []);
});

Deno.test('extractUrls ignores non-http(s) schemes', () => {
  assertEquals(extractUrls('Call ftp://example.com or mailto:a@b.com'), []);
});

// ── stripUrls ────────────────────────────────────────────────────────────

Deno.test('stripUrls removes URLs and collapses whitespace', () => {
  assertEquals(stripUrls('Check https://example.com out today'), 'Check out today');
  assertEquals(stripUrls('https://example.com'), '');
  assertEquals(stripUrls('  '), '');
  assertEquals(stripUrls(null), '');
});

// ── isFetchableUrl (SSRF layer 1) ───────────────────────────────────────

Deno.test('isFetchableUrl accepts plain https/http domains', () => {
  assertEquals(isFetchableUrl('https://example.com'), true);
  assertEquals(isFetchableUrl('http://example.com/path?x=1'), true);
});

Deno.test('isFetchableUrl rejects non-http(s) schemes', () => {
  assertEquals(isFetchableUrl('ftp://example.com'), false);
  assertEquals(isFetchableUrl('javascript:alert(1)'), false);
  assertEquals(isFetchableUrl('data:text/html,hi'), false);
  assertEquals(isFetchableUrl('not a url'), false);
});

Deno.test('isFetchableUrl rejects userinfo', () => {
  assertEquals(isFetchableUrl('https://user:pass@example.com'), false);
});

Deno.test('isFetchableUrl rejects non-default ports', () => {
  assertEquals(isFetchableUrl('https://example.com:8443'), false);
  assertEquals(isFetchableUrl('http://example.com:8080'), false);
});

Deno.test('isFetchableUrl accepts explicit default ports', () => {
  assertEquals(isFetchableUrl('http://example.com:80'), true);
  assertEquals(isFetchableUrl('https://example.com:443'), true);
});

Deno.test('isFetchableUrl rejects localhost and *.local/*.internal', () => {
  assertEquals(isFetchableUrl('http://localhost/'), false);
  assertEquals(isFetchableUrl('http://LOCALHOST/'), false);
  assertEquals(isFetchableUrl('http://printer.local/'), false);
  assertEquals(isFetchableUrl('http://service.internal/'), false);
});

Deno.test('isFetchableUrl rejects raw IPv4 literals', () => {
  assertEquals(isFetchableUrl('http://127.0.0.1/'), false);
  assertEquals(isFetchableUrl('http://93.184.216.34/'), false); // public IP literal too
});

Deno.test('isFetchableUrl rejects IPv4 decimal/hex/octal encodings (normalized by URL parser)', () => {
  // 2130706433 / 0x7f000001 / 017700000001 all normalize to 127.0.0.1's
  // dotted-quad form via the WHATWG URL parser -- exactly the bypass the
  // hostname-based (not string-regex) check exists to catch.
  assertEquals(isFetchableUrl('http://2130706433/'), false);
  assertEquals(isFetchableUrl('http://0x7f000001/'), false);
  assertEquals(isFetchableUrl('http://017700000001/'), false);
});

Deno.test('isFetchableUrl rejects bracketed IPv6 literals', () => {
  assertEquals(isFetchableUrl('http://[::1]/'), false);
  assertEquals(isFetchableUrl('http://[2001:db8::1]/'), false);
  assertEquals(isFetchableUrl('http://[::ffff:127.0.0.1]/'), false);
});

// ── isPrivateIPv4 / isPrivateIPv6 (SSRF layer 2 building blocks) ───────

Deno.test('isPrivateIPv4 flags loopback, private, link-local, metadata, and unspecified', () => {
  assertEquals(isPrivateIPv4('127.0.0.1'), true);
  assertEquals(isPrivateIPv4('10.1.2.3'), true);
  assertEquals(isPrivateIPv4('172.16.0.5'), true);
  assertEquals(isPrivateIPv4('172.31.255.255'), true);
  assertEquals(isPrivateIPv4('192.168.1.1'), true);
  assertEquals(isPrivateIPv4('169.254.169.254'), true); // cloud metadata
  assertEquals(isPrivateIPv4('0.0.0.0'), true);
  assertEquals(isPrivateIPv4('8.8.8.8'), false);
  assertEquals(isPrivateIPv4('172.32.0.1'), false); // just outside 172.16/12
});

Deno.test('isPrivateIPv6 flags loopback, unique-local, link-local, unspecified, and IPv4-mapped', () => {
  assertEquals(isPrivateIPv6('::1'), true);
  assertEquals(isPrivateIPv6('::'), true);
  assertEquals(isPrivateIPv6('fc00::1'), true);
  assertEquals(isPrivateIPv6('fd12:3456::1'), true);
  assertEquals(isPrivateIPv6('fe80::1'), true);
  assertEquals(isPrivateIPv6('::ffff:127.0.0.1'), true);
  assertEquals(isPrivateIPv6('::ffff:10.0.0.5'), true);
  assertEquals(isPrivateIPv6('2001:db8::1'), false);
});

// ── resolvesToBlockedAddress (SSRF layer 2, mocked Deno.resolveDns) ────

function withMockedResolveDns<T>(
  impl: (hostname: string, recordType: string) => Promise<string[]>,
  fn: () => Promise<T>,
): Promise<T> {
  const original = Deno.resolveDns;
  // deno-lint-ignore no-explicit-any
  (Deno as any).resolveDns = impl;
  return fn().finally(() => {
    // deno-lint-ignore no-explicit-any
    (Deno as any).resolveDns = original;
  });
}

Deno.test('resolvesToBlockedAddress allows a hostname resolving to a public address', async () => {
  const blocked = await withMockedResolveDns(
    async (_hostname, recordType) => (recordType === 'A' ? ['93.184.216.34'] : []),
    () => resolvesToBlockedAddress('example.com'),
  );
  assertEquals(blocked, false);
});

Deno.test('resolvesToBlockedAddress blocks a hostname resolving to a private IPv4 address', async () => {
  const blocked = await withMockedResolveDns(
    async (_hostname, recordType) => (recordType === 'A' ? ['169.254.169.254'] : []),
    () => resolvesToBlockedAddress('evil.example.com'),
  );
  assertEquals(blocked, true);
});

Deno.test('resolvesToBlockedAddress blocks a hostname resolving to a private IPv6 address', async () => {
  const blocked = await withMockedResolveDns(
    async (_hostname, recordType) => (recordType === 'AAAA' ? ['fc00::1'] : []),
    () => resolvesToBlockedAddress('evil.example.com'),
  );
  assertEquals(blocked, true);
});

Deno.test('resolvesToBlockedAddress tolerates one record type failing', async () => {
  const blocked = await withMockedResolveDns(
    async (_hostname, recordType) => {
      if (recordType === 'A') {
        throw new Error('no A record');
      }
      return ['2001:db8::1'];
    },
    () => resolvesToBlockedAddress('example.com'),
  );
  assertEquals(blocked, false);
});

Deno.test('resolvesToBlockedAddress treats total DNS failure as blocked', async () => {
  const blocked = await withMockedResolveDns(
    async () => {
      throw new Error('NXDOMAIN');
    },
    () => resolvesToBlockedAddress('nowhere.example.com'),
  );
  assertEquals(blocked, true);
});

Deno.test('isSafeToFetch combines both SSRF layers', async () => {
  const safe = await withMockedResolveDns(
    async (_hostname, recordType) => (recordType === 'A' ? ['93.184.216.34'] : []),
    () => isSafeToFetch('https://example.com'),
  );
  assertEquals(safe, true);

  const unsafeByLayer1 = await isSafeToFetch('http://127.0.0.1/');
  assertEquals(unsafeByLayer1, false);

  const unsafeByLayer2 = await withMockedResolveDns(
    async (_hostname, recordType) => (recordType === 'A' ? ['10.0.0.1'] : []),
    () => isSafeToFetch('https://internal-looking-name.example.com'),
  );
  assertEquals(unsafeByLayer2, false);
});

// ── parseHtmlTitle / cleanTitle ─────────────────────────────────────────

Deno.test('parseHtmlTitle prefers og:title over <title>', () => {
  const html = `
    <html><head>
      <meta property="og:title" content="OG Title Wins">
      <title>Fallback Title</title>
    </head></html>
  `;
  assertEquals(parseHtmlTitle(html), 'OG Title Wins');
});

Deno.test('parseHtmlTitle falls back to <title> when og:title is absent', () => {
  const html = '<html><head><title>Just a Title</title></head></html>';
  assertEquals(parseHtmlTitle(html), 'Just a Title');
});

Deno.test('parseHtmlTitle handles attribute order and quote style variations', () => {
  const html = `<meta content='Content First' property='og:title'>`;
  assertEquals(parseHtmlTitle(html), 'Content First');
});

Deno.test('parseHtmlTitle returns null when neither tag is present', () => {
  assertEquals(parseHtmlTitle('<html><body>No title here</body></html>'), null);
});

Deno.test('cleanTitle decodes named and numeric HTML entities', () => {
  assertEquals(cleanTitle('Tom &amp; Jerry'), 'Tom & Jerry');
  assertEquals(cleanTitle('&lt;script&gt;'), '<script>');
  assertEquals(cleanTitle('&quot;Quoted&quot; &#39;Apos&#39;'), '"Quoted" \'Apos\'');
  assertEquals(cleanTitle('Caf&#233; &#x2764;'), 'Café ❤');
});

Deno.test('cleanTitle preserves invalid numeric entities without throwing', () => {
  assertEquals(
    cleanTitle('Too high: &#1114112; and &#x110000;'),
    'Too high: &#1114112; and &#x110000;',
  );
  assertEquals(
    cleanTitle('Surrogates: &#55296; and &#xDFFF;'),
    'Surrogates: &#55296; and &#xDFFF;',
  );
  assertEquals(
    cleanTitle('Huge: &#999999999999999999999999999999999999999999999999999999;'),
    'Huge: &#999999999999999999999999999999999999999999999999999999;',
  );
});

Deno.test('cleanTitle decodes valid numeric entities at Unicode scalar boundaries', () => {
  assertEquals(cleanTitle('Before &#xD7FF; after'), `Before ${String.fromCodePoint(0xd7ff)} after`);
  assertEquals(cleanTitle('Before &#xE000; after'), `Before ${String.fromCodePoint(0xe000)} after`);
  assertEquals(
    cleanTitle('Before &#x10FFFF; after'),
    `Before ${String.fromCodePoint(0x10ffff)} after`,
  );
});

Deno.test('cleanTitle strips bidi/format control chars and ASCII control chars', () => {
  const withBidi = 'Evil‮title⁦reorder⁩';
  assertEquals(cleanTitle(withBidi), 'Eviltitlereorder');
  assertEquals(cleanTitle('has nullbell'), 'hasnullbell');
});

Deno.test('cleanTitle collapses whitespace and trims', () => {
  assertEquals(cleanTitle('  Lots   of\n\tspace   '), 'Lots of space');
});

Deno.test('cleanTitle caps at 200 characters', () => {
  const long = 'x'.repeat(250);
  const result = cleanTitle(long);
  assertEquals(result?.length, 200);
});

Deno.test('cleanTitle returns null for empty/whitespace-only input', () => {
  assertEquals(cleanTitle(''), null);
  assertEquals(cleanTitle('   '), null);
  assertEquals(cleanTitle(null), null);
  assertEquals(cleanTitle(undefined), null);
});

Deno.test('cleanTitle keeps suffixes verbatim (no stripping)', () => {
  assertEquals(
    cleanTitle('Alexisonfire - We Are The End - YouTube'),
    'Alexisonfire - We Are The End - YouTube',
  );
});

// ── fetchPageTitle (mocked fetch + Deno.resolveDns) ─────────────────────

function withMockedFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

Deno.test('fetchPageTitle returns the parsed title for a plain HTML response', async () => {
  const title = await withMockedResolveDns(
    async (_hostname, recordType) => (recordType === 'A' ? ['93.184.216.34'] : []),
    () =>
      withMockedFetch(
        () =>
          Promise.resolve(
            new Response('<html><head><title>Example Domain</title></head></html>', {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            }),
          ),
        () => fetchPageTitle('https://example.com'),
      ),
  );

  assertEquals(title, 'Example Domain');
});

Deno.test('fetchPageTitle returns null when a redirect points at a blocked host', async () => {
  let fetchCalls = 0;

  const title = await withMockedResolveDns(
    async (hostname, recordType) => {
      if (recordType !== 'A') return [];
      // The redirect target resolves to a public address at the DNS layer,
      // but its literal hostname is an IP -- layer 1 must still reject it
      // before a second fetch is ever made.
      return hostname === 'example.com' ? ['93.184.216.34'] : ['93.184.216.34'];
    },
    () =>
      withMockedFetch(
        () => {
          fetchCalls += 1;
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: 'http://169.254.169.254/latest/meta-data' },
            }),
          );
        },
        () => fetchPageTitle('https://example.com'),
      ),
  );

  assertEquals(title, null);
  assertEquals(fetchCalls, 1); // never followed the redirect to the blocked host
});

Deno.test('fetchPageTitle follows an allowed redirect chain', async () => {
  const title = await withMockedResolveDns(
    async (_hostname, recordType) => (recordType === 'A' ? ['93.184.216.34'] : []),
    () =>
      withMockedFetch(
        (input) => {
          const url = typeof input === 'string' ? input : (input as Request).url;
          if (url === 'https://example.com/') {
            return Promise.resolve(
              new Response(null, { status: 301, headers: { location: 'https://example.com/final' } }),
            );
          }
          return Promise.resolve(
            new Response('<title>Final Page</title>', {
              status: 200,
              headers: { 'content-type': 'text/html' },
            }),
          );
        },
        () => fetchPageTitle('https://example.com/'),
      ),
  );

  assertEquals(title, 'Final Page');
});

Deno.test('fetchPageTitle returns null on non-HTML content-type', async () => {
  const title = await withMockedResolveDns(
    async (_hostname, recordType) => (recordType === 'A' ? ['93.184.216.34'] : []),
    () =>
      withMockedFetch(
        () =>
          Promise.resolve(
            new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
          ),
        () => fetchPageTitle('https://example.com'),
      ),
  );

  assertEquals(title, null);
});

Deno.test('fetchPageTitle returns null and never throws on network failure', async () => {
  const title = await withMockedResolveDns(
    async (_hostname, recordType) => (recordType === 'A' ? ['93.184.216.34'] : []),
    () =>
      withMockedFetch(
        () => Promise.reject(new Error('network down')),
        () => fetchPageTitle('https://example.com'),
      ),
  );

  assertEquals(title, null);
});

Deno.test('fetchPageTitle rejects an unfetchable URL before ever calling fetch', async () => {
  let called = false;

  const title = await withMockedFetch(
    () => {
      called = true;
      return Promise.resolve(new Response('should not be reached'));
    },
    () => fetchPageTitle('http://127.0.0.1/'),
  );

  assertEquals(title, null);
  assertEquals(called, false);
});

Deno.test('smoke: stripUrls output never contains a URL that extractUrls would find', () => {
  const text = 'Went to https://example.com/park and posted https://x.com/status/1 today.';
  const stripped = stripUrls(text);
  assertEquals(extractUrls(stripped).length, 0);
  assertStringIncludes(stripped, 'Went to');
  assertStringIncludes(stripped, 'today.');
});
