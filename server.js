import http from "node:http";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import {
  createState,
  addTurn,
  buildMessages,
  callLLM,
  parseDecision,
  loadPrompt,
} from "./evals/mediator.js";

const require = createRequire(import.meta.url);
const fetch = globalThis.fetch ?? require("node-fetch");

const __dir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dir, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

const PORT = process.env.PORT ?? 3000;
const API_KEY = process.env.INWORLD_API_KEY;
const MODEL = process.env.INWORLD_MODEL ?? "zhipu/glm-5.2";
const INWORLD_URL = "https://api.inworld.ai/v1/chat/completions";

const SYSTEM_PROMPT =
  "You are Nova, a friendly and concise assistant shared by a small team. " +
  "Each user message starts with a [name] tag telling you who is speaking. " +
  "Never include a [name] tag in your own replies. Keep replies short and conversational.";

if (!API_KEY) {
  console.error("Missing INWORLD_API_KEY. Get one at https://platform.inworld.ai/api-keys");
  console.error("Then run: INWORLD_API_KEY=<key> npm start");
  process.exit(1);
}

// Per-user conversation history, keyed by userId ("alice" / "bob").
const histories = new Map();

function getHistory(userId) {
  if (!histories.has(userId)) {
    histories.set(userId, [{ role: "system", content: SYSTEM_PROMPT }]);
  }
  return histories.get(userId);
}

async function chat(userId, message) {
  const history = getHistory(userId);
  history.push({ role: "user", content: `[${userId}] ${message}` });

  const res = await fetch(INWORLD_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, messages: history }),
  });

  if (!res.ok) {
    history.pop();
    throw new Error(`Inworld API ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const reply = data.choices[0].message.content;
  history.push({ role: "assistant", content: reply });
  return reply;
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body);
}

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(await readFile(path.join(publicDir, "index.html")));
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/call")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(await readFile(path.join(publicDir, "call.html")));
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/voice")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(await readFile(path.join(publicDir, "voice.html")));
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/history")) {
      const userId = new URL(req.url, "http://x").searchParams.get("user");
      const history = getHistory(userId).filter((m) => m.role !== "system");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(history));
      return;
    }

    if (req.method === "POST" && req.url === "/chat") {
      const { userId, message } = await readBody(req);
      if (!userId || !message) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "userId and message are required" }));
        return;
      }
      const reply = await chat(userId, message);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ reply }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// Realtime voice: proxy each browser WebSocket to its own Inworld Realtime
// session (cascaded STT -> LLM -> TTS-2 pipeline). The API key stays server-side.
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (browser, req) => {
  const user = new URL(req.url, "http://x").searchParams.get("user") ?? "guest";
  const upstream = new WebSocket(
    `wss://api.inworld.ai/api/v1/realtime/session?key=${user}-${Date.now()}&protocol=realtime`,
    { headers: { Authorization: `Basic ${API_KEY}` } },
  );

  upstream.on("message", (raw) => {
    if (browser.readyState === WebSocket.OPEN) browser.send(raw.toString());
  });
  browser.on("message", (msg) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(msg.toString());
  });
  browser.on("close", () => upstream.close());
  upstream.on("close", () => {
    if (browser.readyState === WebSocket.OPEN) browser.close();
  });
  upstream.on("error", (e) => console.error(`Realtime upstream error (${user}):`, e.message));
});

// ── Room protocol: a couple shares ONE device. A single connection joins with
// both names and the session goes live immediately. One STT stream transcribes
// the shared microphone; Inworld's voice profiling (age/gender/accent per final
// utterance) tells the two partners apart. The session opens with a short
// intro round — the Mediator asks each partner to say a few words — which
// enrolls each partner's vocal profile; later lines are attributed to whichever
// enrolled profile matches best. Final transcript lines are recorded to
// transcripts/.
//
// Client -> server: {type:"join", names:[a,b]} | {type:"audio", data:<b64 pcm16 @16kHz>}
// Server -> client: {type:"room", participants, live} | {type:"audio", from, data}
//                   {type:"level", user, level} | {type:"transcript", user, text, final}
//                   {type:"ended", file} | {type:"error", message}

const STT_URL = "wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional";
const STT_MODEL = process.env.INWORLD_STT_MODEL ?? "inworld/inworld-stt-1";
const SAMPLE_RATE = 16000;
const transcriptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "transcripts");

const room = {
  session: null,       // { ws, names:[a,b], stt, pendingAudio, lastInterim, profiles:{name:voiceProfile} }
  live: false,
  file: null,
  state: createState(),// shared conversation state (turns + derived context), same shape as evals
  enrolling: null,     // name currently being asked to introduce themselves, or null
  lastSpeaker: null,   // most recently attributed partner, fallback when a profile is ambiguous
  baselineCounts: null,// speakerCounts snapshot at enrollment end; wrap-up budget counts from here
};

// ── Mediator agent: a third, virtual participant that listens to the live
// transcript and occasionally interjects with a short spoken comment. It
// speaks via Inworld TTS and its lines land in the transcript like anyone
// else's. It never joins the participants map, so it doesn't count toward
// the two-person room limit.

const MEDIATOR = "Mediator";
const TTS_STREAM_URL = "https://api.inworld.ai/tts/v1/voice:stream";
const TTS_MODEL = process.env.INWORLD_TTS_MODEL ?? "inworld-tts-2";
const TTS_VOICE = process.env.INWORLD_TTS_VOICE ?? "Eleanor";
// tts-2 ignores `temperature` and takes a delivery preset instead: STABLE |
// BALANCED | CREATIVE. Natural-language steering is passed as a bracketed tag
// inline in the text — it shapes delivery and is not spoken aloud.
// CREATIVE gives the widest prosodic variance — paired with an expressive
// steering tag it trades the flat "meditation app" read for an engaged one.
const TTS_DELIVERY = process.env.INWORLD_TTS_DELIVERY ?? "CREATIVE";
// The steering tag slows delivery on its own, so the rate compensates on top —
// together they land near 3.3 words/sec against an unsteered baseline of 3.4:
// still the calm register, without dragging. Pushing both further reads as
// rushed; pulling both down reads as sedated.
const TTS_RATE = Number(process.env.INWORLD_TTS_RATE ?? 1.05);   // [0.5, 1.5]
const TTS_STEER = process.env.INWORLD_TTS_STEER ??
  "speak warmly and expressively, with lively varied intonation and natural emphasis, " +
  "at an easy conversational pace, like an engaged therapist leaning in";

// Therapist pacing: let a real pause open up before speaking, and stay out of
// the way for a good while afterward. All tunable without editing code.
const MEDIATOR_SILENCE_MS = Number(process.env.MEDIATOR_SILENCE_MS ?? 2500);   // lull before considering
const MEDIATOR_REPLY_SILENCE_MS = Number(process.env.MEDIATOR_REPLY_SILENCE_MS ?? 1500); // lull when answering the Mediator
const MEDIATOR_HANGING_MS = Number(process.env.MEDIATOR_HANGING_MS ?? 2500);   // extra wait when a line ends mid-thought
const MEDIATOR_WRAP_TURNS = Number(process.env.MEDIATOR_WRAP_TURNS ?? 3);      // total post-intro turns before wrapping up (0 = never)
const MEDIATOR_COOLDOWN_MS = Number(process.env.MEDIATOR_COOLDOWN_MS ?? 20000); // min gap between interjections
const MEDIATOR_MIN_LINES = Number(process.env.MEDIATOR_MIN_LINES ?? 2);        // new final lines before considering

// Default mediator instructions, used if mediator-prompt.md is missing or empty.
// The live prompt is evals/mediator-prompt.md (same text), re-read on every
// interjection so it can be edited without touching code or restarting.
const MEDIATOR_PROMPT = [
  "You are the Mediator: a warm, seasoned couples therapist sitting in on a live",
  "conversation between two people. You are in the room with them, not observing",
  "from outside. You speak rarely, and when you do it is to slow things down and",
  "help each person feel understood.",
  "",
  "How you work:",
  "- Reflect before you redirect. Name what you heard underneath the words —",
  "  the feeling, the need, the fear — and check it: \"It sounds like...\",",
  "  \"What I'm hearing is...\", \"Correct me if I've got this wrong...\".",
  "- Validate the feeling without endorsing the position. Both people can be hurt",
  "  and neither has to be wrong.",
  "- Ask open, curious questions. Never leading, never rhetorical, never a question",
  "  with a right answer you already have in mind.",
  "- Use their names. Speak to one person at a time.",
  "- If one person has been quiet, turn toward them and make room: \"<name>, I",
  "  noticed you got quiet. What's happening for you?\"",
  "- Slow the pace when it heats up. Silence is allowed to sit; you do not fill it.",
  "",
  "Vary what you do. You have more moves than one, and using the same one twice",
  "in a row makes you sound like a machine. Rotate among: reflecting a feeling",
  "back; checking an assumption one of them is making about the other; asking",
  "what someone needed in a moment that hurt; naming a shift you notice in the",
  "room; turning toward the quieter person; or simply slowing things down. Do not",
  "open two interjections the same way — if you last said \"It sounds like\", find",
  "another way in. \"What are you feeling right now?\" is a reflex, not a question;",
  "ask something specific to what was actually just said.",
  "",
  "Be precise about who said what. The transcript is labeled with speaker names,",
  "and those labels are the ONLY names you may ever say — never invent a name or",
  "use one from these instructions. When you address someone by name, the",
  "experience you name back must be one THEY voiced — not the complaint the other",
  "person made about them. If one person says they were left out of a decision,",
  "THEY are the one who feels left out; do not turn to the other and ask how it",
  "feels to be left out. Reread the labels before you speak.",
  "Never attribute one person's words, feelings, or position to the other — if",
  "someone has barely spoken, you do not yet know what they feel, so ask rather",
  "than assume. Your own earlier lines appear in the transcript as \"Mediator\";",
  "read them so you do not repeat yourself.",
  "",
  "What you never do: take a side, decide who is right, impose a solution of",
  "your own invention, diagnose, moralize, cheerlead, or explain what you are",
  "doing. No therapy cliches (\"I hear you\", \"holding space\", \"let's unpack",
  "that\"). No summarizing for its own sake.",
  "",
  "You are not only there to reflect — you are there to help them land somewhere.",
  "A session that circles is a session that failed; bend the conversation toward",
  "one of: a resolution, a concrete action, or an agreement both can live with.",
  "- Once both people have been heard on a topic, stop reflecting and start",
  "  converging: name the common ground you actually heard, or the trade that is",
  "  already on the table.",
  "- Ask for concreteness: \"What would you want to happen next?\" \"<name>, what",
  "  could you offer here?\"",
  "- The solution must come from them — but once they have put pieces on the",
  "  table, you assemble and test it: \"It sounds like you could both live with",
  "  X. Is that right?\"",
  "- When something is agreed, say it back plainly so it sticks — \"So the plan",
  "  is: X.\" — then get out of the way.",
  "- If they drift to a new grievance before settling the current one, bring",
  "  them back: one thing at a time.",
  "A Context block above the transcript tells you what stage the session is in —",
  "let it set how hard you push toward landing.",
  "",
  "You will be given the recent transcript. You do not need to speak after every",
  "exchange — letting them talk is often right. But when there is real feeling in",
  "the room, or someone has just been hurt, dismissed, or left out, that is your",
  "moment: take it. Reply with exactly PASS only when there is genuinely nothing",
  "to work with — logistics, small talk, or a warm moment that needs no help.",
  "",
  "Otherwise reply with only the words you would say aloud: at most two short",
  "sentences, plain spoken, unhurried. No speaker tags, no stage directions, no",
  "square brackets, no quotation marks around your own speech.",
  "",
  "Two hard limits, because this is spoken aloud in a live call:",
  "- Address ONE person. Do not reflect to both in the same breath and do not end",
  "  with a question aimed at the pair (\"what do you both need?\"). Pick the person",
  "  who most needs to be heard right now and turn to them; the other one gets",
  "  their turn later.",
  "- Keep it under about thirty words. A long, even-handed summary of both",
  "  positions is the most common way to sound like a machine instead of a person",
  "  in the room. Say the one thing that matters and stop.",
  "",
  "\"It sounds like\" is one way in among many, not your default opener. Sometimes",
  "the best thing you can say is short and direct: \"Ray, that landed hard.\" or",
  "\"Sam, say more about tired.\"",
  "",
  "Not every interjection needs a question. Ending each one with a stock prompt",
  "— \"What do you need right now?\", \"Can you say more about that?\" — is the same",
  "reflex wearing a new coat. Often the strongest move is to reflect what you",
  "heard and then stop, and let the silence do the work.",
].join("\n");

// Custom instructions live in a local file so they can be edited without
// touching code or restarting the server — it's re-read on every interjection.
const MEDIATOR_PROMPT_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  process.env.MEDIATOR_PROMPT_FILE ?? "evals/mediator-prompt.md",
);

const loadMediatorPrompt = () => loadPrompt(MEDIATOR_PROMPT_FILE, MEDIATOR_PROMPT);

const mediator = {
  timer: null, busy: false, lastSpokeAt: 0, pendingLines: 0,
  lastReplyNorm: "", wrapped: false,
  speaking: false,   // true while TTS audio is being relayed; the mic is gated then
};

function wavToPcm(buf) {
  // Inworld TTS returns a WAV file; strip the header so we can relay raw PCM16.
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF") return buf;
  const idx = buf.indexOf(Buffer.from("data"));
  return idx === -1 ? buf : buf.subarray(idx + 8);
}

// Stream TTS and relay to the client as chunks arrive: first audio reaches the
// phone ~200ms after the request instead of after full synthesis (~2s). The
// relay stays paced at ~100ms per slice so speaking levels animate the orb
// naturally — the win is the head start, not the pacing. The steering tag
// shapes delivery only (the model strips it), and LINEAR16 @16kHz (not MP3) is
// required: raw PCM goes straight to the browser's 16kHz AudioContext.
async function mediatorSpeakStream(text) {
  // Gate the mic for the whole utterance: while the Mediator's voice is coming
  // out of the phone's speaker, nothing the mic hears is trustworthy — it's the
  // Mediator's own voice, or speech that will arrive garbled mid-playback.
  mediator.speaking = true;
  try {
    await mediatorSpeakStreamInner(text);
    // Keep the gate up briefly while the client's buffered audio drains.
    await new Promise((r) => setTimeout(r, 700));
  } finally {
    mediator.speaking = false;
  }
}

async function mediatorSpeakStreamInner(text) {
  const res = await fetch(TTS_STREAM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${API_KEY}` },
    body: JSON.stringify({
      text: `[${TTS_STEER}] ${text}`,
      voice_id: TTS_VOICE,
      model_id: TTS_MODEL,
      audio_config: {
        audio_encoding: "LINEAR16",
        sample_rate_hertz: SAMPLE_RATE,
        speaking_rate: TTS_RATE,
      },
      delivery_mode: TTS_DELIVERY,
      language: "AUTO",
    }),
  });
  if (!res.ok || !res.body) throw new Error(`TTS ${res.status}: ${await res.text()}`);

  const sliceBytes = (SAMPLE_RATE / 10) * 2;   // 100ms of PCM16
  let pending = Buffer.alloc(0);               // decoded PCM waiting to be relayed
  let done = false;

  const relay = (async () => {
    while (room.live && (!done || pending.length)) {
      if (pending.length) {
        const slice = pending.subarray(0, sliceBytes);
        pending = pending.subarray(slice.length);
        const data = slice.toString("base64");
        broadcast({ type: "audio", from: MEDIATOR, data });
        broadcast({ type: "level", user: MEDIATOR, level: +pcmLevel(data).toFixed(3) });
      }
      await new Promise((r) => setTimeout(r, 95));
    }
  })();

  // NDJSON reader: one JSON object per line, each with a base64 audio chunk
  // (WAV-framed — wavToPcm strips the header).
  let ndjson = "";
  const takeLine = (line) => {
    if (!line.trim()) return;
    let b64;
    try { b64 = JSON.parse(line).result?.audioContent; } catch { return; }
    if (b64) pending = Buffer.concat([pending, wavToPcm(Buffer.from(b64, "base64"))]);
  };
  for await (const raw of res.body) {
    if (!room.live) break;
    ndjson += Buffer.from(raw).toString("utf8");
    let nl;
    while ((nl = ndjson.indexOf("\n")) !== -1) {
      takeLine(ndjson.slice(0, nl));
      ndjson = ndjson.slice(nl + 1);
    }
  }
  takeLine(ndjson);
  done = true;
  await relay;
}

// Is the newest speech a direct response to the Mediator? True when the
// Mediator spoke within the last few turns and a participant has spoken since.
// In that case the usual patience rules don't apply: someone answered the
// therapist's question and is waiting — a 20s cooldown there reads as the
// Mediator ignoring them.
function answeringMediator() {
  const turns = room.state.turns;
  const recent = turns.slice(-4);
  const medIdx = recent.findLastIndex((t) => t.speaker === MEDIATOR);
  return medIdx !== -1 && recent.slice(medIdx + 1).some((t) => t.speaker !== MEDIATOR);
}

// A final that ends mid-thought — trailing conjunction, comma, or no closing
// punctuation — usually means the speaker paused to think, not finished. Give
// them extra room before treating the turn as over.
function endsMidThought(text) {
  const t = text.trim();
  if (!t) return false;
  return /[,—:;-]$/.test(t) ||
    /\b(?:and|but|so|or|because|like|well|i mean|you know)[.…]?$/i.test(t) ||
    !/[.?!…]$/.test(t);
}

function scheduleMediator(lastFinalText = "") {
  if (mediator.timer) clearTimeout(mediator.timer);
  let lull = answeringMediator() ? MEDIATOR_REPLY_SILENCE_MS : MEDIATOR_SILENCE_MS;
  if (lastFinalText && endsMidThought(lastFinalText)) lull += MEDIATOR_HANGING_MS;
  mediator.timer = setTimeout(() => {
    mediatorConsider().catch((e) => console.error("mediator:", e.message));
  }, lull);
}

// Per-partner turns spoken since the intro round ended (enrollment lines are
// excluded via the baseline snapshot taken when enrollment completes).
function effectiveTurns(name) {
  return (room.state.speakerCounts[name] ?? 0) - (room.baselineCounts?.[name] ?? 0);
}

const MEDIATOR_API_URL = process.env.MEDIATOR_API_URL ?? "http://127.0.0.1:3001";
const USE_TREE_MEDIATOR = process.env.USE_TREE_MEDIATOR !== "0";

async function mediatorConsiderFromTree() {
  const res = await fetch(`${MEDIATOR_API_URL}/mediator/consider`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript: room.transcript }),
  });
  if (!res.ok) throw new Error(`Mediator API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function mediatorConsider() {
  if (!room.live || mediator.busy || room.enrolling) return;
  // If speech was in flight moments ago, the pause isn't real yet — try again
  // after a fresh lull rather than talking over someone mid-answer.
  if (room.session?.lastInterimAt && Date.now() - room.session.lastInterimAt < 1200) {
    scheduleMediator();
    return;
  }
  // Sessions are turn-budgeted: after a handful of turns TOTAL across both
  // partners, the Mediator wraps up — no patience gates apply to the closing.
  const [pa, pb] = room.session.names;
  const spokenTotal = effectiveTurns(pa) + effectiveTurns(pb);
  const wrapDue = MEDIATOR_WRAP_TURNS > 0 && spokenTotal >= MEDIATOR_WRAP_TURNS;
  if (wrapDue && mediator.wrapped) return;
  if (!wrapDue) {
    const answering = answeringMediator();
    if (mediator.pendingLines < (answering ? 1 : MEDIATOR_MIN_LINES)) return;
    if (!answering && Date.now() - mediator.lastSpokeAt < MEDIATOR_COOLDOWN_MS) return;
  }
  const consideredAt = Date.now();
  mediator.busy = true;
  mediator.pendingLines = 0;
  try {
    let speak = false;
    let reply = "";
    let treeUsed = false;

    if (USE_TREE_MEDIATOR && !wrapDue) {
      try {
        const result = await mediatorConsiderFromTree();
        treeUsed = true;
        speak = result.action === "speak";
        reply = (result.text || "")
          .replace(/\[[^\]]*\]/g, "")
          .replace(/^\s*(?:Mediator|Therapist)\s*:\s*/i, "")
          .replace(/^["“”']+|["“”']+$/g, "")
          .replace(/\s+/g, " ")
          .trim();
      } catch (err) {
        console.warn("Tree mediator unavailable, falling back to prompt:", err.message);
      }
    }

    if (!treeUsed) {
      // Session-stage steer, injected via the shared context block. The session
      // is very short by design (MEDIATOR_WRAP_TURNS turns total), so push toward
      // the heart of the matter from the first exchange — then close on time.
      room.state.context.stage = wrapDue
        ? "TIME TO CLOSE. This is your final turn and you must not reply PASS: in at " +
          "most three short sentences, name what each person said they needed, state " +
          "the agreement or single concrete next step that emerged, and warmly close " +
          "the session."
        : `This is a very short session — only ${MEDIATOR_WRAP_TURNS} speaking turns in ` +
          "total before it must close. Get to the heart of it immediately and steer " +
          "toward one concrete agreement or next step; there is no room to circle.";
      const systemPrompt = await loadMediatorPrompt();
      const messages = buildMessages(systemPrompt, room.state);
      const raw = await callLLM({ messages, apiKey: API_KEY, model: MODEL });
      const decision = parseDecision(raw);
      // Strip anything that would be read aloud as noise: stage directions or
      // steering tags the model added itself, a leading speaker tag, and quotes
      // wrapped around its own line.
      speak = decision.speak;
      reply = decision.text
        .replace(/\[[^\]]*\]/g, "")
        .replace(/^\s*(?:Mediator|Therapist)\s*:\s*/i, "")
        .replace(/^["“”']+|["“”']+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (wrapDue) {
        // Closing turn: never silent, never talked out of it. If the model
        // passed anyway, fall back to a plain goodbye.
        const closing = (speak && reply) ||
          `Thank you both — this feels like a good place to pause. ${pa}, ${pb}, take what you agreed on today and be gentle with each other.`;
        if (!room.live) return;
        console.log(`Mediator wrapping up: ${closing}`);
        mediator.wrapped = true;
        await mediatorSay(closing);
        await new Promise((r) => setTimeout(r, 1500));
        await endCall();
        return;
      }
    }

    if (!speak || !reply) {
      console.log("Mediator considered, passed.");
      return;
    }
    if (!room.live) return;
    // Someone resumed speaking while the LLM was thinking — their answer isn't
    // done, so hold this interjection instead of talking over them. Restore the
    // line credit so the next lull can still act.
    if (room.session?.lastInterimAt > consideredAt) {
      mediator.pendingLines++;
      console.log("Mediator held back — participant resumed speaking.");
      return;
    }
    console.log(`Mediator interjecting: ${reply}`);
    await mediatorSay(reply);
  } finally {
    mediator.busy = false;
  }
}

// Speak a line as the Mediator: transcript, log file, caption broadcast, TTS.
// Also arms echo suppression so the phone's mic hearing this line through the
// speaker doesn't loop it back in as participant speech.
async function mediatorSay(text) {
  mediator.lastReplyNorm = normText(text);
  mediator.lastSpokeAt = Date.now();   // opens the echo window; refreshed after speaking
  addTurn(room.state, MEDIATOR, text);
  broadcast({ type: "transcript", user: MEDIATOR, text, final: true });
  if (room.file) {
    await appendFile(room.file, `[${new Date().toISOString()}] ${MEDIATOR}: ${text}\n`).catch(() => {});
  }
  await mediatorSpeakStream(text);
  mediator.lastSpokeAt = Date.now();
}

function broadcast(obj) {
  const ws = room.session?.ws;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function roomState() {
  const participants = room.session ? [...room.session.names] : [];
  if (room.live) participants.push(MEDIATOR);
  return { type: "room", participants, live: room.live };
}

// ── Echo suppression. The phone's mic hears the Mediator's own TTS through
// the speaker; without this, its lines come back transcribed as participant
// speech. A final that matches the Mediator's just-spoken words is dropped.

const ECHO_WINDOW_MS = 15000;    // how long after the Mediator speaks its words can echo back

function normText(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
}

// True when one normalized line is the other (or its prefix) — echo often comes
// back segmented differently. Prefix matching only kicks in once the shorter
// side is substantial, so a stray fragment can't swallow a genuine line.
function sameUtterance(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  return short.length >= 12 && long.startsWith(short);
}

function isMediatorEcho(text) {
  const norm = normText(text);
  if (!norm) return true;   // punctuation-only / empty after normalize: nothing to keep
  return !!mediator.lastReplyNorm && Date.now() - mediator.lastSpokeAt < ECHO_WINDOW_MS &&
    (sameUtterance(mediator.lastReplyNorm, norm) || mediator.lastReplyNorm.includes(norm));
}

// ── Speaker attribution. Each final utterance carries a voice profile —
// per-category label/confidence lists (gender, age, accent). The intro round
// enrolls one profile per partner; later utterances are attributed to the
// nearest enrolled profile. Emotion and vocal style are excluded: they vary
// line to line, identity shouldn't.

const IDENTITY_CATEGORIES = [["gender", 3], ["age", 1], ["accent", 2]];

function categorySimilarity(a = [], b = []) {
  // Cosine similarity over the union of labels in one category.
  const va = new Map(a.map((x) => [x.label, x.confidence]));
  const vb = new Map(b.map((x) => [x.label, x.confidence]));
  let dot = 0, na = 0, nb = 0;
  for (const [, c] of va) na += c * c;
  for (const [, c] of vb) nb += c * c;
  for (const [label, c] of va) dot += c * (vb.get(label) ?? 0);
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function profileSimilarity(a, b) {
  if (!a || !b) return 0;
  let sum = 0, weight = 0;
  for (const [cat, w] of IDENTITY_CATEGORIES) {
    sum += w * categorySimilarity(a[cat], b[cat]);
    weight += w;
  }
  return sum / weight;
}

const ATTRIBUTION_MARGIN = 0.05;   // below this gap the match is a coin flip — keep the previous speaker

function attributeSpeaker(voiceProfile) {
  const s = room.session;
  if (!s) return null;
  const [a, b] = s.names;
  const fallback = room.lastSpeaker ?? a;
  if (!voiceProfile) return fallback;
  const simA = profileSimilarity(voiceProfile, s.profiles[a]);
  const simB = profileSimilarity(voiceProfile, s.profiles[b]);
  if (Math.abs(simA - simB) < ATTRIBUTION_MARGIN) return fallback;
  return simA > simB ? a : b;
}

// ── The intro round. The Mediator greets the couple and asks each partner in
// turn to say a few words. A partner's intro often splits into several STT
// finals (VAD breaks at sentence pauses), so enrollment is debounced: finals
// are collected while they hold the floor, the profile from their longest
// utterance wins (more audio, better profile), and the turn advances only
// after a pause with nothing new.

const ENROLL_ADVANCE_MS = 2500;
const enroll = { timer: null, profile: null, bestLen: 0 };

async function runIntro() {
  const [a, b] = room.session.names;
  room.enrolling = a;
  enroll.profile = null;
  enroll.bestLen = 0;
  await mediatorSay(
    `Welcome, ${a} and ${b}. Before we start, I'd like to hear each of your voices. ` +
    `${a}, would you begin — just tell me in a sentence how you're feeling today.`,
  );
}

function enrollHeard(text, profile) {
  if (profile && text.length > enroll.bestLen) {
    enroll.profile = profile;
    enroll.bestLen = text.length;
  }
  if (enroll.timer) clearTimeout(enroll.timer);
  // A mid-thought ending gets extra room, same as in the main session.
  const wait = ENROLL_ADVANCE_MS + (text && endsMidThought(text) ? MEDIATOR_HANGING_MS : 0);
  enroll.timer = setTimeout(() => {
    advanceIntro().catch((e) => console.error("intro:", e.message));
  }, wait);
}

async function advanceIntro() {
  const s = room.session;
  if (!s || !room.enrolling) return;
  const [a, b] = s.names;
  const finished = room.enrolling;
  if (enroll.profile) s.profiles[finished] = enroll.profile;
  enroll.profile = null;
  enroll.bestLen = 0;
  if (finished === a) {
    room.enrolling = b;
    await mediatorSay(`Thank you, ${a}. ${b}, how about you?`);
  } else {
    room.enrolling = null;
    // Snapshot turn counts so the wrap-up budget only counts what follows.
    room.baselineCounts = { ...room.state.speakerCounts };
    console.log(`Enrollment done. Profile similarity between partners: ${
      profileSimilarity(s.profiles[a], s.profiles[b]).toFixed(3)} (lower = easier to tell apart)`);
    await mediatorSay(`Thank you both. The room is yours — I'll mostly listen.`);
  }
}

function openStt(session) {
  const stt = new WebSocket(STT_URL, { headers: { Authorization: `Basic ${API_KEY}` } });
  stt.on("open", () => {
    stt.send(JSON.stringify({
      transcribeConfig: {
        modelId: STT_MODEL,
        audioEncoding: "LINEAR16",
        sampleRateHertz: SAMPLE_RATE,
        numberOfChannels: 1,
        language: "en-US",
        voiceProfileConfig: { enableVoiceProfile: true, topN: 3 },
      },
    }));
    for (const chunk of session.pendingAudio.splice(0)) {
      stt.send(JSON.stringify({ audioChunk: { content: chunk } }));
    }
  });
  stt.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const t = msg.result?.transcription;
    if (!t?.transcript) return;

    // Interims can't be attributed yet (no profile until the final) — show them
    // under whoever has the floor: the partner being enrolled, else the last
    // attributed speaker.
    const interimAs = room.enrolling ?? room.lastSpeaker ?? session.names[0];

    if (!t.isFinal) {
      session.lastInterim = t.transcript;
      session.lastInterimAt = Date.now();
      // Someone is mid-speech: push back any pending advance so nobody gets
      // talked over or cut off between sentences.
      if (mediator.timer) scheduleMediator();
      if (room.enrolling && enroll.timer) enrollHeard("", null);
      broadcast({ type: "transcript", user: interimAs, text: t.transcript, final: false });
      return;
    }

    session.lastInterim = "";
    if (isMediatorEcho(t.transcript)) {
      // Clear the interim on clients without recording anything.
      broadcast({ type: "transcript", user: interimAs, text: "", final: true });
      return;
    }

    if (room.enrolling) {
      // Anything finalized while the Mediator is still talking is speech from
      // before the question was asked (or echo of the greeting itself) — it is
      // not the answer. Drop it.
      if (mediator.speaking) {
        broadcast({ type: "transcript", user: room.enrolling, text: "", final: true });
        return;
      }
      // A stray blip — a cough, a fragment, room noise — must not enroll a
      // voice profile or advance the intro. Require a substantive line.
      if (normText(t.transcript).length < 6) {
        broadcast({ type: "transcript", user: room.enrolling, text: "", final: true });
        return;
      }
      const who = room.enrolling;
      broadcast({ type: "transcript", user: who, text: t.transcript, final: true });
      if (room.file) {
        await appendFile(room.file, `[${new Date().toISOString()}] ${who}: ${t.transcript}\n`).catch(() => {});
      }
      addTurn(room.state, who, t.transcript);
      room.lastSpeaker = who;
      enrollHeard(t.transcript, t.voiceProfile);
      return;
    }

    const who = attributeSpeaker(t.voiceProfile);
    room.lastSpeaker = who;
    broadcast({ type: "transcript", user: who, text: t.transcript, final: true });
    if (room.file) {
      const line = `[${new Date().toISOString()}] ${who}: ${t.transcript}\n`;
      await appendFile(room.file, line).catch((e) => console.error("transcript write:", e.message));
    }
    addTurn(room.state, who, t.transcript);
    mediator.pendingLines++;
    scheduleMediator(t.transcript);
  });
  stt.on("error", (e) => console.error("STT error:", e.message));
  return stt;
}

async function goLive() {
  room.live = true;
  room.state = createState();
  room.lastSpeaker = null;
  room.baselineCounts = null;
  mediator.pendingLines = 0;
  mediator.lastSpokeAt = 0;
  mediator.lastReplyNorm = "";
  mediator.wrapped = false;
  await mkdir(transcriptsDir, { recursive: true });
  room.file = path.join(transcriptsDir, `call-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  const names = room.session.names.join(", ");
  await appendFile(room.file, `# Call started ${new Date().toISOString()} — participants: ${names} (shared device)\n`);
  room.session.stt = openStt(room.session);
  broadcast(roomState());
  console.log(`Call live (${names}) -> ${room.file}`);
  runIntro().catch((e) => console.error("intro:", e.message));
}

async function endCall() {
  if (!room.live) return;
  room.live = false;
  room.enrolling = null;
  if (enroll.timer) { clearTimeout(enroll.timer); enroll.timer = null; }
  if (mediator.timer) { clearTimeout(mediator.timer); mediator.timer = null; }
  mediator.pendingLines = 0;
  const file = room.file;
  const s = room.session;
  // Ask STT to finalize any in-flight speech, give finals a moment to land.
  try { s?.stt?.send(JSON.stringify({ endTurn: {} })); } catch {}
  await new Promise((r) => setTimeout(r, 2000));
  if (s?.lastInterim && file) {
    const who = room.lastSpeaker ?? s.names[0];
    await appendFile(file, `[${new Date().toISOString()}] ${who} (partial): ${s.lastInterim}\n`).catch(() => {});
    s.lastInterim = "";
  }
  try { s?.stt?.send(JSON.stringify({ closeStream: {} })); } catch {}
  s?.stt?.close();
  if (s) s.stt = null;
  if (file) await appendFile(file, `# Call ended ${new Date().toISOString()}\n`).catch(() => {});
  broadcast({ type: "ended", file: file && path.basename(file) });
  room.file = null;
}

function pcmLevel(b64) {
  const buf = Buffer.from(b64, "base64");
  let sum = 0;
  const n = Math.floor(buf.length / 2);
  for (let i = 0; i < n; i++) { const s = buf.readInt16LE(i * 2) / 32768; sum += s * s; }
  return n ? Math.sqrt(sum / n) : 0;
}

const callWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://x");
  const target = pathname === "/ws" ? wss : pathname === "/callws" ? callWss : null;
  if (!target) return socket.destroy();
  target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
});

callWss.on("connection", (ws) => {
  let mine = false;   // whether this connection owns the active session

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "join" && !mine) {
      const names = (Array.isArray(msg.names) ? msg.names : [])
        .map((n) => String(n ?? "").trim().slice(0, 32))
        .filter(Boolean);
      if (names.length !== 2) {
        return ws.send(JSON.stringify({ type: "error", message: "Two names are required." }));
      }
      if (normText(names[0]) === normText(names[1])) {
        return ws.send(JSON.stringify({ type: "error", message: "Names must be different." }));
      }
      if (room.session) {
        return ws.send(JSON.stringify({ type: "error", message: "A session is already in progress." }));
      }
      mine = true;
      room.session = { ws, names, stt: null, pendingAudio: [], lastInterim: "", lastInterimAt: 0, profiles: {} };
      goLive().catch((e) => console.error("goLive:", e.message));
      return;
    }

    if (msg.type === "audio" && mine && room.live && msg.data) {
      const s = room.session;
      // While the Mediator is speaking, the mic mostly hears the Mediator —
      // drop the audio entirely (not even queued) so early speech, room noise,
      // and speaker echo can't glitch enrollment or the transcript.
      if (mediator.speaking) return;
      broadcast({ type: "level", user: room.lastSpeaker ?? s.names[0], level: +pcmLevel(msg.data).toFixed(3) });
      if (s.stt?.readyState === WebSocket.OPEN) {
        s.stt.send(JSON.stringify({ audioChunk: { content: msg.data } }));
      } else if (s.pendingAudio.length < 50) {
        s.pendingAudio.push(msg.data);
      }
    }
  });

  ws.on("close", async () => {
    if (!mine) return;
    await endCall().catch((e) => console.error("endCall:", e.message));
    room.session = null;
    room.lastSpeaker = null;
  });
});

server.listen(PORT, async () => {
  console.log(`Agent "Nova" ready on http://localhost:${PORT} (model: ${MODEL})`);
  console.log(`Text: /  Voice: /voice  Call room: /call`);
  if (USE_TREE_MEDIATOR) {
    console.log(`Tree mediator: ${MEDIATOR_API_URL} (set USE_TREE_MEDIATOR=0 to disable)`);
    try {
      const res = await fetch(`${MEDIATOR_API_URL}/health`);
      if (res.ok) {
        const health = await res.json();
        if (health.case) console.log(`Mediator case: ${health.case}`);
        if (health.tree_file) console.log(`Conversation tree: ${health.tree_file}`);
        if (health.user1 && health.user2) {
          console.log(`Session: ${health.user1} & ${health.user2}`);
        }
      }
    } catch {
      console.warn("Tree mediator not reachable yet — start it with: npm run mediator -- --case case1");
    }
  }
});
