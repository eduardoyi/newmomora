import { assertEquals } from 'jsr:@std/assert@1';
import { readObjectBodyToBytes } from './r2.ts';

Deno.test('readObjectBodyToBytes merges web stream chunks', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3]));
      controller.close();
    },
  });

  const bytes = await readObjectBodyToBytes({
    transformToWebStream: () => stream,
  });

  assertEquals(Array.from(bytes), [1, 2, 3]);
});
