import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"]
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
    }
  },
  {
    files: [
      "src/control/internalApi*.ts",
      "src/control/console/**/*.{ts,tsx}",
      "src/observability/*.ts",
      "src/db/runtimeMappers.ts",
      "src/db/agentRuntimeArtifactRepository.ts",
      "src/tools/random*.ts",
      "src/tools/spotify/*.ts"
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "error"
    }
  }
];
