import { assertEquals } from 'jsr:@std/assert@1';

Deno.test('bundled default style asset is present for edge fallback', async () => {
  const bundledUrl = new URL('./assets/default-style.png', import.meta.url);
  const bytes = await Deno.readFile(bundledUrl);

  assertEquals(bytes.byteLength > 1000, true);
});
