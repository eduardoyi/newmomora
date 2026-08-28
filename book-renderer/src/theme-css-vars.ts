import { colors, lavender, fonts, spacing, radius } from './theme';

/**
 * Renders theme.ts as CSS custom properties so plain .css files can use
 * `var(--ink)` etc. without a CSS-in-JS dependency. Injected once at app
 * startup (see preview/main.tsx). theme.ts stays the single source of truth.
 */
export function themeCssVariables(): string {
  const lines: string[] = [':root {'];
  for (const [key, value] of Object.entries(colors)) lines.push(`  --color-${key}: ${value};`);
  for (const [key, value] of Object.entries(lavender)) lines.push(`  --lavender-${key}: ${value};`);
  for (const [key, value] of Object.entries(fonts)) lines.push(`  --font-${key}: ${value};`);
  for (const [key, value] of Object.entries(spacing)) lines.push(`  --space-${key}: ${value}px;`);
  for (const [key, value] of Object.entries(radius)) lines.push(`  --radius-${key}: ${value}px;`);
  lines.push('}');
  return lines.join('\n');
}
