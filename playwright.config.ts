import { defineConfig } from "@playwright/test";

// API-request specs only — no browser project needed. Targets the live worker
// by default; every check is side-effect-free (see CLAUDE.md "Testing safely").
export default defineConfig({
  testDir: "./e2e",
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.FORMS_BASE_URL ?? "https://forms.gr8gray.dev",
  },
});
