import { getObjectBytes } from './r2.ts';

const bundledDefaultStyleUrl = new URL('./assets/default-style.png', import.meta.url);

export interface IllustrationStyleDefinition {
  token: string;
  referencePath: string;
  description: string;
}

export const DEFAULT_ILLUSTRATION_STYLE_TOKEN = 'default';

const ILLUSTRATION_STYLES: Record<string, IllustrationStyleDefinition> = {
  default: {
    token: 'default',
    referencePath: '_assets/styles/default.png',
    description:
      'whimsical hand-drawn storybook illustration, gouache and watercolor textures, gentle ink outlines, warm nostalgic lighting, simplified charming character design, emotional family-memory feeling, subtle magical realism, children\'s book aesthetic',
  },
};

export function getIllustrationStyle(token: string): IllustrationStyleDefinition {
  return ILLUSTRATION_STYLES[token] ?? ILLUSTRATION_STYLES[DEFAULT_ILLUSTRATION_STYLE_TOKEN];
}

export function getStyleReferencePath(token: string): string {
  return getIllustrationStyle(token).referencePath;
}

export function getStyleDescription(token: string): string {
  return getIllustrationStyle(token).description;
}

export function getStyleReferenceUrl(token: string): string | null {
  const baseUrl = Deno.env.get('R2_PUBLIC_ASSETS_BASE_URL');

  if (!baseUrl) {
    return null;
  }

  const path = getStyleReferencePath(token);
  return `${baseUrl.replace(/\/$/, '')}/${path}`;
}

export async function loadStyleReferenceBytes(
  token: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const referencePath = getStyleReferencePath(token);

  try {
    const bytes = await getObjectBytes(referencePath);
    return { bytes, contentType: 'image/png' };
  } catch (error) {
    console.error(
      'loadStyleReferenceBytes R2 fetch failed',
      referencePath,
      error instanceof Error ? error.message : 'unknown',
    );
  }

  const url = getStyleReferenceUrl(token);

  if (url) {
    try {
      const response = await fetch(url);

      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        const contentType = response.headers.get('content-type') ?? 'image/png';
        return { bytes, contentType };
      }

      console.error('loadStyleReferenceBytes public fetch failed', response.status, token);
    } catch (error) {
      console.error(
        'loadStyleReferenceBytes public fetch failed',
        token,
        error instanceof Error ? error.message : 'unknown',
      );
    }
  }

  if (getIllustrationStyle(token).token === DEFAULT_ILLUSTRATION_STYLE_TOKEN) {
    try {
      const bytes = await Deno.readFile(bundledDefaultStyleUrl);
      console.log('loadStyleReferenceBytes using bundled default style asset');
      return { bytes, contentType: 'image/png' };
    } catch (error) {
      console.error(
        'loadStyleReferenceBytes bundled asset failed',
        token,
        error instanceof Error ? error.message : 'unknown',
      );
    }
  }

  return null;
}
