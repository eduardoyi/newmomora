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
]);
