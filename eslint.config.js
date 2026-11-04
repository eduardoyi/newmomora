// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    // Deno code (supabase/) has its own conventions and globals — covered by
    // deno lint / test:edge, not this config.
    ignores: ["dist/*", "supabase/**", "android/**", "ios/**"],
  },
  {
    rules: {
      // React-Compiler-era hooks rules. The existing Animated.Value-in-useRef
      // and sync-props-to-state patterns trip these throughout the app;
      // demoted to warnings until those patterns are refactored deliberately.
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  {
    // Metro has no tree shaking: the lucide barrel evaluates ~1,700 icon
    // modules at startup. Deep-import each icon instead.
    files: ["app/**/*.{ts,tsx}", "src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "lucide-react-native",
              message:
                "Don't import from the lucide-react-native barrel (it bundles every icon). Use a deep import: `import Search from 'lucide-react-native/icons/search';`",
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
]);
