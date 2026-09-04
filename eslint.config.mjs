import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Flat config, no FlatCompat: eslint-config-next through the compat layer trips
 * a circular-structure crash on this ESLint version, and the rules that
 * actually matter here are the type-safety and no-eval ones below.
 */
export default tseslint.config(
  { ignores: [".next/**", "node_modules/**", "data/**", "next-env.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        console: "readonly",
        process: "readonly",
        fetch: "readonly",
        AbortSignal: "readonly",
        crypto: "readonly",
      },
    },
    rules: {
      // The engines are financial maths: an unused binding is usually a real
      // mistake, not noise.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-undef": "off", // TypeScript already resolves identifiers
    },
  }
);
