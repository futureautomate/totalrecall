import type { CondensedMessage, Digest } from "./types.js";

export type ClaudeRunner = (prompt: string) => Promise<string>;
export const CHUNK_CHAR_LIMIT = 48_000;
// Hard ceiling on how much condensed transcript one digest may send to the
// LLM. Monster sessions (a real one condensed to ~950k chars) would otherwise
// fan out into dozens-to-hundreds of chunk calls; beyond this cap we keep the
// head and tail of the conversation and mark the omitted middle.
export const MAX_DIGEST_INPUT_CHARS = 192_000;

export function capCondensed(
  msgs: CondensedMessage[], max = MAX_DIGEST_INPUT_CHARS,
): CondensedMessage[] {
  const total = msgs.reduce((n, m) => n + m.text.length, 0);
  if (total <= max) return msgs;
  const half = Math.floor(max / 2);
  const head: CondensedMessage[] = [];
  let size = 0, i = 0;
  for (; i < msgs.length && size + msgs[i].text.length <= half; i++) {
    head.push(msgs[i]); size += msgs[i].text.length;
  }
  const tail: CondensedMessage[] = [];
  size = 0;
  let j = msgs.length - 1;
  for (; j > i && size + msgs[j].text.length <= half; j--) {
    tail.unshift(msgs[j]); size += msgs[j].text.length;
  }
  const omitted = j - i + 1;
  return [
    ...head,
    { role: "user", text: `[... ${omitted} messages omitted from the middle of a very long session ...]` },
    ...tail,
  ];
}

const DIGEST_INSTRUCTIONS = `You are indexing a Claude Code session transcript.
Reply with ONLY a JSON object, no other text:
{
  "title": "short 5-10 word title of what this session was about",
  "summary": "3-6 sentences: what was worked on, what happened, current state",
  "decisions": ["each notable decision made, with its reason, as one string"],
  "outcome": "completed" | "ongoing" | "abandoned",
  "topics": ["3-8 short lowercase tags like auth, deploy, sqlite"]
}`;

export function extractJson(text: string): any {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("no JSON object in reply");
  return JSON.parse(text.slice(start, end + 1));
}

function validate(raw: any): Digest {
  const outcomes = new Set(["completed", "ongoing", "abandoned"]);
  return {
    title: String(raw.title ?? "Untitled session").slice(0, 120),
    summary: String(raw.summary ?? "").slice(0, 2000),
    decisions: Array.isArray(raw.decisions) ? raw.decisions.map(String).slice(0, 12) : [],
    outcome: outcomes.has(raw.outcome) ? raw.outcome : "ongoing",
    topics: Array.isArray(raw.topics)
      ? raw.topics.map((t: any) => String(t).toLowerCase()).slice(0, 8) : [],
  };
}

function renderTranscript(msgs: CondensedMessage[]): string {
  return msgs.map(m => `${m.role.toUpperCase()}: ${m.text}`).join("\n\n");
}

function chunk(msgs: CondensedMessage[]): CondensedMessage[][] {
  const chunks: CondensedMessage[][] = [];
  let current: CondensedMessage[] = [];
  let size = 0;
  for (const m of msgs) {
    if (size + m.text.length > CHUNK_CHAR_LIMIT && current.length > 0) {
      chunks.push(current); current = []; size = 0;
    }
    current.push(m); size += m.text.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function digestSession(
  condensed: CondensedMessage[], run: ClaudeRunner,
): Promise<Digest> {
  const chunks = chunk(capCondensed(condensed));
  if (chunks.length === 1) {
    const reply = await run(`${DIGEST_INSTRUCTIONS}\n\nTRANSCRIPT:\n${renderTranscript(chunks[0])}`);
    return validate(extractJson(reply));
  }
  const partials: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const reply = await run(
      `PARTIAL SUMMARY task: summarize this portion (${i + 1}/${chunks.length}) of a coding
session in 5-8 sentences of plain text. Include work done, decisions, and state.\n\n` +
      renderTranscript(chunks[i]));
    partials.push(reply.trim());
  }
  const reply = await run(
    `${DIGEST_INSTRUCTIONS}\n\nTRANSCRIPT (as sequential partial summaries):\n` +
    partials.map((p, i) => `PART ${i + 1}:\n${p}`).join("\n\n"));
  return validate(extractJson(reply));
}
