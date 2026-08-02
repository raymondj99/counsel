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
    turns: [],           // [{ speaker, text, emotion? }] in order
    speakerCounts: {},   // speaker -> number of final lines
    context: {},         // your dynamic key/value context, injected into the prompt
  };
}

// Top Inworld STT voice-profile label for a category (emotion, vocalStyle, …).
export function topVoiceLabel(voiceProfile, category) {
  const top = voiceProfile?.[category]?.[0];
  return top?.label ?? null;
}

export function addTurn(state, speaker, text, meta = {}) {
  const turn = { speaker, text };
  if (meta.emotion) turn.emotion = meta.emotion;
  state.turns.push(turn);
  state.speakerCounts[speaker] = (state.speakerCounts[speaker] ?? 0) + 1;
  return state;
}

export function formatTurnLine({ speaker, text, emotion }) {
  const prefix = emotion ? `[emotion: ${emotion}] ` : "";
  return `${speaker}: ${prefix}${text}`;
}

export function addTurnWithVoice(state, speaker, text, voiceProfile) {
  const emotion = topVoiceLabel(voiceProfile, "emotion");
  addTurn(state, speaker, text, { emotion });
  updateEmotionContext(state, emotion);
  return state;
}

// Labels from Inworld STT emotion profiling that signal a heated moment.
const HEATED_EMOTION = /^(heated|angry|frustrated|upset|contempt|aggressive|hostile)/i;

export function updateEmotionContext(state, emotion) {
  if (!emotion || !HEATED_EMOTION.test(emotion)) return state;
  state.context.heated =
    `Voice tone recently detected as "${emotion}" — information only; slow the pace and de-escalate, but do not end the session.`;
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
  return state.turns.slice(-limit).map(formatTurnLine).join("\n");
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
    `Recent transcript ([emotion: …] tags are voice-detected from STT — informational only, never a reason to end the session):\n${recent}\n\n` +
    "Respond with exactly one of:\n" +
    "- PASS — stay silent this turn\n" +
    "- CLOSE: <words> — a resolution or concrete agreement is reached; say your closing line and end the session\n" +
    "- Otherwise, only the words you would say aloud (your interjection). If the exchange is heated, de-escalate and stay in the session — do not try to pause or end it.";
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

// Interpret a reply: PASS -> silent; CLOSE: -> speak and end session; else interject.
export function parseDecision(reply) {
  const text = (reply ?? "").trim();
  if (!text || /^PASS\b/i.test(text)) {
    return { speak: false, text: "", endSession: false };
  }
  const closeMatch = text.match(/^CLOSE:\s*(.*)$/is);
  if (closeMatch) {
    return {
      speak: true,
      text: closeMatch[1].trim(),
      endSession: true,
      endReason: "resolution",
    };
  }
  // Legacy STOP: prefix — de-escalate but never end the session.
  const stopMatch = text.match(/^STOP:\s*(.*)$/is);
  if (stopMatch) {
    return { speak: true, text: stopMatch[1].trim(), endSession: false };
  }
  return { speak: true, text, endSession: false };
}

// Convenience: state + prompt -> decision, in one call. Used by both callers.
export async function decide({ state, systemPrompt, apiKey, model, url, limit }) {
  const messages = buildMessages(systemPrompt, state, limit);
  const reply = await callLLM({ messages, apiKey, model, url });
  return { ...parseDecision(reply), messages, reply };
}
