// Shared mediator logic.
//
// This module is the single source of truth for how the mediator's LLM step
// works: how conversation state is tracked, how your own dynamic context is
// injected, how the prompt is assembled, and how the reply is interpreted.
//
// It is imported by BOTH the live server (../server.js) and the offline A/B
// runner (./run.js), so live traffic and eval runs exercise the exact same
// prompts and decision logic.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROMPT_FILE = path.join(HERE, "mediator-prompt.md");
export const INWORLD_URL = "https://api.inworld.ai/v1/chat/completions";

// ── Conversation state ──────────────────────────────────────────────────────
// Beyond the raw transcript, keep your own derived signals in `context`. It is
// a plain object you can mutate however you like; buildContext() renders it into
// the prompt, so this is your hook for steering the LLM dynamically without
// editing the base prompt (e.g. state.context.topic = "rent split").
export function createState() {
  return {
    turns: [],           // [{ speaker, text }] in order
    speakerCounts: {},   // speaker -> number of final lines
    context: {},         // your dynamic key/value context, injected into the prompt
  };
}

export function addTurn(state, speaker, text) {
  state.turns.push({ speaker, text });
  state.speakerCounts[speaker] = (state.speakerCounts[speaker] ?? 0) + 1;
  return state;
}

// Render your custom state into a short context block for the LLM. Edit this to
// decide exactly what the model sees. Anything you drop into state.context shows
// up here automatically; the speaker turn counts are included as an example.
export function buildContext(state) {
  const lines = [];
  const counts = Object.entries(state.speakerCounts);
  if (counts.length) {
    lines.push("Turn counts — " + counts.map(([s, n]) => `${s}: ${n}`).join(", "));
  }
  for (const [key, value] of Object.entries(state.context)) {
    lines.push(`${key}: ${value}`);
  }
  return lines.join("\n");
}

export function transcriptText(state, limit = 30) {
  return state.turns.slice(-limit).map((t) => `${t.speaker}: ${t.text}`).join("\n");
}

// ── Prompt assembly ─────────────────────────────────────────────────────────
export async function loadPrompt(promptFile = DEFAULT_PROMPT_FILE, fallback = "") {
  try {
    const text = (await readFile(promptFile, "utf8")).trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}

// Build the exact messages array sent to the LLM — identical for live and eval.
export function buildMessages(systemPrompt, state, limit = 30) {
  const context = buildContext(state);
  const recent = transcriptText(state, limit);
  const userContent =
    (context ? `Context:\n${context}\n\n` : "") +
    `Recent transcript:\n${recent}\n\nRespond with PASS or your interjection.`;
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];
}

// ── LLM call + decision ─────────────────────────────────────────────────────
export async function callLLM({ messages, apiKey, model, url = INWORLD_URL }) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${apiKey}` },
    body: JSON.stringify({ model, messages }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

// Interpret a reply: exactly "PASS" -> stay silent, otherwise speak the text.
export function parseDecision(reply) {
  const text = (reply ?? "").trim();
  if (!text || /^PASS\b/i.test(text)) return { speak: false, text: "" };
  return { speak: true, text };
}

// Convenience: state + prompt -> decision, in one call. Used by both callers.
export async function decide({ state, systemPrompt, apiKey, model, url, limit }) {
  const messages = buildMessages(systemPrompt, state, limit);
  const reply = await callLLM({ messages, apiKey, model, url });
  return { ...parseDecision(reply), messages, reply };
}
