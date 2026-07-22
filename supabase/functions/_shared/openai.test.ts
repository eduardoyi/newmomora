import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { chatJson, editImageWithReferences, generateImage } from './openai.ts';

const TEST_OPENAI_KEY = 'test-openai-key';

async function withMockedOpenAiFetch(run: (models: string[]) => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get('OPENAI_API_KEY');
  const models: string[] = [];

  Deno.env.set('OPENAI_API_KEY', TEST_OPENAI_KEY);
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = request.headers.get('Content-Type')?.includes('application/json')
      ? await request.json()
      : await request.formData();
    models.push(String(body instanceof FormData ? body.get('model') : body.model));
    return new Response('mocked failure', { status: 503 });
  };

  try {
    await run(models);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) {
      Deno.env.delete('OPENAI_API_KEY');
    } else {
      Deno.env.set('OPENAI_API_KEY', originalKey);
    }
  }
}

Deno.test('generateImage retries the fallback model after a non-abort provider failure', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get('OPENAI_API_KEY');
  const models: string[] = [];

  Deno.env.set('OPENAI_API_KEY', TEST_OPENAI_KEY);
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await request.json();
    models.push(body.model);

    if (body.model === 'gpt-image-2') {
      return new Response('temporary provider failure', { status: 503 });
    }

    return new Response(JSON.stringify({ data: [{ b64_json: 'AQID' }] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const bytes = await generateImage('A gentle scene');
    assertEquals(bytes, new Uint8Array([1, 2, 3]));
    assertEquals(models, ['gpt-image-2', 'gpt-image-1.5']);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) {
      Deno.env.delete('OPENAI_API_KEY');
    } else {
      Deno.env.set('OPENAI_API_KEY', originalKey);
    }
  }
});

Deno.test('generateImage does not retry another model after a deterministic provider refusal', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get('OPENAI_API_KEY');
  const models: string[] = [];

  Deno.env.set('OPENAI_API_KEY', TEST_OPENAI_KEY);
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await request.json();
    models.push(body.model);
    return new Response('policy refusal', { status: 400 });
  };

  try {
    await assertRejects(() => generateImage('A gentle scene'));
    assertEquals(models, ['gpt-image-2']);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) {
      Deno.env.delete('OPENAI_API_KEY');
    } else {
      Deno.env.set('OPENAI_API_KEY', originalKey);
    }
  }
});

Deno.test('chatJson forwards its abort signal to fetch', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get('OPENAI_API_KEY');
  const controller = new AbortController();
  let receivedSignal: AbortSignal | null | undefined;

  Deno.env.set('OPENAI_API_KEY', TEST_OPENAI_KEY);
  globalThis.fetch = async (_input, init) => {
    receivedSignal = init?.signal;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await chatJson('system', 'user', { signal: controller.signal });
    assertEquals(receivedSignal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete('OPENAI_API_KEY');
    else Deno.env.set('OPENAI_API_KEY', originalKey);
  }
});

Deno.test('generateImage does not start its fallback after an aborted primary request', async () => {
  await withMockedOpenAiFetch(async (models) => {
    const controller = new AbortController();
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = await request.json();
      models.push(body.model);
      controller.abort('deadline reached');
      throw new DOMException('Aborted', 'AbortError');
    };

    await assertRejects(() => generateImage('A gentle scene', { signal: controller.signal }));
    assertEquals(models, ['gpt-image-2']);
  });
});

Deno.test('editImageWithReferences does not start another model after its request is aborted', async () => {
  await withMockedOpenAiFetch(async (models) => {
    const controller = new AbortController();
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = await request.formData();
      models.push(String(body.get('model')));
      controller.abort('deadline reached');
      return new Response('mocked failure', { status: 503 });
    };

    await assertRejects(() =>
      editImageWithReferences(
        'A gentle scene',
        [
          {
            bytes: new Uint8Array([1]),
            contentType: 'image/jpeg',
            filename: 'reference.jpg',
          },
        ],
        { signal: controller.signal },
      ),
    );
    assertEquals(models, ['gpt-image-2']);
  });
});

Deno.test('editImageWithReferences does not start an edit when its parent deadline already expired', async () => {
  await withMockedOpenAiFetch(async (models) => {
    const controller = new AbortController();
    controller.abort('deadline reached');

    await assertRejects(() =>
      editImageWithReferences(
        'A gentle scene',
        [{ bytes: new Uint8Array([1]), contentType: 'image/jpeg', filename: 'reference.jpg' }],
        { signal: controller.signal, fallbackHedgeDelayMs: 0 },
      ),
    );
    assertEquals(models, []);
  });
});

Deno.test('a parent deadline abort stops a hedged edit before its fallback starts', async () => {
  await withMockedOpenAiFetch(async (models) => {
    const controller = new AbortController();
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = await request.formData();
      models.push(String(body.get('model')));
      controller.abort('deadline reached');
      return new Response('provider timeout', { status: 503 });
    };

    await assertRejects(() =>
      editImageWithReferences(
        'A gentle scene',
        [{ bytes: new Uint8Array([1]), contentType: 'image/jpeg', filename: 'reference.jpg' }],
        { signal: controller.signal, fallbackHedgeDelayMs: 0 },
      ),
    );
    assertEquals(models, ['gpt-image-2']);
  });
});

Deno.test('multi-reference edit hedges a slow primary and returns the fallback result', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get('OPENAI_API_KEY');
  const models: string[] = [];

  Deno.env.set('OPENAI_API_KEY', TEST_OPENAI_KEY);
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await request.formData();
    const model = String(body.get('model'));
    models.push(model);

    if (model === 'gpt-image-2') {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    }

    return new Response(JSON.stringify({ data: [{ b64_json: 'AQID' }] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const bytes = await editImageWithReferences(
      'A gentle scene',
      [{ bytes: new Uint8Array([1]), contentType: 'image/jpeg', filename: 'reference.jpg' }],
      { fallbackHedgeDelayMs: 0 },
    );
    assertEquals(bytes, new Uint8Array([1, 2, 3]));
    assertEquals(models, ['gpt-image-2', 'gpt-image-1.5']);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete('OPENAI_API_KEY');
    else Deno.env.set('OPENAI_API_KEY', originalKey);
  }
});

Deno.test('editImageWithReferences forwards output settings to the Image API', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get('OPENAI_API_KEY');
  const fields: Record<string, string> = {};

  Deno.env.set('OPENAI_API_KEY', TEST_OPENAI_KEY);
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await request.formData();
    for (const key of ['quality', 'output_format', 'output_compression']) {
      fields[key] = String(body.get(key));
    }
    return new Response(JSON.stringify({ data: [{ b64_json: 'AQID' }] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await editImageWithReferences(
      'A gentle scene',
      [{ bytes: new Uint8Array([1]), contentType: 'image/jpeg', filename: 'reference.jpg' }],
      { quality: 'low', outputFormat: 'webp', outputCompression: 85 },
    );
    assertEquals(fields, {
      quality: 'low',
      output_format: 'webp',
      output_compression: '85',
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete('OPENAI_API_KEY');
    else Deno.env.set('OPENAI_API_KEY', originalKey);
  }
});

Deno.test('editImageWithReferences does not retry a deterministic provider rejection', async () => {
  await withMockedOpenAiFetch(async (models) => {
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = await request.formData();
      models.push(String(body.get('model')));
      return new Response('policy refusal', { status: 400 });
    };

    await assertRejects(() =>
      editImageWithReferences(
        'A gentle scene',
        [{ bytes: new Uint8Array([1]), contentType: 'image/jpeg', filename: 'reference.jpg' }],
      ),
    );
    assertEquals(models, ['gpt-image-2']);
  });
});

Deno.test('editImageWithReferences retries the alternate edit model after a transient 408', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get('OPENAI_API_KEY');
  const models: string[] = [];

  Deno.env.set('OPENAI_API_KEY', TEST_OPENAI_KEY);
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await request.formData();
    const model = String(body.get('model'));
    models.push(model);
    if (model === 'gpt-image-2') {
      return new Response('provider timeout', { status: 408 });
    }
    return new Response(JSON.stringify({ data: [{ b64_json: 'AQID' }] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const bytes = await editImageWithReferences(
      'A gentle scene',
      [{ bytes: new Uint8Array([1]), contentType: 'image/jpeg', filename: 'reference.jpg' }],
    );
    assertEquals(bytes, new Uint8Array([1, 2, 3]));
    assertEquals(models, ['gpt-image-2', 'gpt-image-1.5']);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete('OPENAI_API_KEY');
    else Deno.env.set('OPENAI_API_KEY', originalKey);
  }
});

Deno.test('reference edits never fall through to text-only image generation', async () => {
  await withMockedOpenAiFetch(async (models) => {
    await assertRejects(() =>
      editImageWithReferences(
        'A gentle scene',
        [{ bytes: new Uint8Array([1]), contentType: 'image/jpeg', filename: 'reference.jpg' }],
      ),
    );
    assertEquals(models, ['gpt-image-2', 'gpt-image-1.5']);
  });
});

Deno.test('a hedged fallback policy rejection does not cancel a healthy primary edit', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get('OPENAI_API_KEY');
  const models: string[] = [];

  Deno.env.set('OPENAI_API_KEY', TEST_OPENAI_KEY);
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await request.formData();
    const model = String(body.get('model'));
    models.push(model);

    if (model === 'gpt-image-1.5') {
      return new Response('policy refusal', { status: 400 });
    }

    return await new Promise<Response>((resolve) => {
      setTimeout(
        () => resolve(new Response(JSON.stringify({ data: [{ b64_json: 'AQID' }] }), {
          headers: { 'Content-Type': 'application/json' },
        })),
        10,
      );
    });
  };

  try {
    const bytes = await editImageWithReferences(
      'A gentle scene',
      [{ bytes: new Uint8Array([1]), contentType: 'image/jpeg', filename: 'reference.jpg' }],
      { fallbackHedgeDelayMs: 0 },
    );
    assertEquals(bytes, new Uint8Array([1, 2, 3]));
    assertEquals(models, ['gpt-image-2', 'gpt-image-1.5']);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete('OPENAI_API_KEY');
    else Deno.env.set('OPENAI_API_KEY', originalKey);
  }
});
