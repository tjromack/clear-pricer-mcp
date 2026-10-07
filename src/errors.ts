/**
 * A question the release cannot answer as asked. The SDK turns a thrown error into a tool result with
 * `isError: true`, so the message is what the assistant reads: it says what was searched, why nothing matched, and
 * what to try instead. An empty result is never returned as success (CLAUDE.md pin 3).
 */
export class NoMatchError extends Error {
  override readonly name = "NoMatchError";

  constructor(problem: string, details: { found?: string[]; tryInstead?: string[] } = {}) {
    const parts = [problem];
    if (details.found?.length) parts.push(`What the release does have:\n${details.found.map((l) => `- ${l}`).join("\n")}`);
    if (details.tryInstead?.length) parts.push(`Try:\n${details.tryInstead.map((l) => `- ${l}`).join("\n")}`);
    super(parts.join("\n\n"));
  }
}
