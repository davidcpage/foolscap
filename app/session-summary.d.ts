// Types for session-summary.js (plain ESM, runs under node --test). Hand-written so vite-fs-plugin.ts can
// import the transcript-summary parser without allowJs. Keep in sync with the exports in session-summary.js.

export function userText(content: unknown): string | null;

export function sessionSummaryFromText(text: string): {
  title: string | null;
  turns: number;
  messages: number;
};
