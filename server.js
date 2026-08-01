import http from "node:http";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT ?? 3000;
const API_KEY = process.env.INWORLD_API_KEY;
const MODEL = process.env.INWORLD_MODEL ?? "openai/gpt-4o-mini";
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

// ── Room protocol: two users join a call; when both are in, the session goes
// live. Each participant's audio is relayed to the other and streamed to their
// own Inworld STT connection, so speaker identity comes from the channel.
// Final transcript lines are recorded to transcripts/.
//
// Client -> server: {type:"join", name} | {type:"audio", data:<b64 pcm16 @16kHz>}
// Server -> client: {type:"room", participants, live} | {type:"audio", from, data}
//                   {type:"level", user, level} | {type:"transcript", user, text, final}
//                   {type:"ended", file} | {type:"error", message}

const STT_URL = "wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional";
const STT_MODEL = process.env.INWORLD_STT_MODEL ?? "inworld/inworld-stt-1";
const SAMPLE_RATE = 16000;
const transcriptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "transcripts");

const room = { participants: new Map(), live: false, file: null };

function broadcast(obj, except) {
  const raw = JSON.stringify(obj);
  for (const p of room.participants.values()) {
    if (p.ws !== except && p.ws.readyState === WebSocket.OPEN) p.ws.send(raw);
  }
}

function roomState() {
  return { type: "room", participants: [...room.participants.keys()], live: room.live };
}

function openStt(participant) {
  const stt = new WebSocket(STT_URL, { headers: { Authorization: `Basic ${API_KEY}` } });
  stt.on("open", () => {
    stt.send(JSON.stringify({
      transcribeConfig: {
        modelId: STT_MODEL,
        audioEncoding: "LINEAR16",
        sampleRateHertz: SAMPLE_RATE,
        numberOfChannels: 1,
        language: "en-US",
      },
    }));
    for (const chunk of participant.pendingAudio.splice(0)) {
      stt.send(JSON.stringify({ audioChunk: { content: chunk } }));
    }
  });
  stt.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const t = msg.result?.transcription;
    if (!t?.transcript) return;
    broadcast({ type: "transcript", user: participant.name, text: t.transcript, final: !!t.isFinal });
    if (t.isFinal) {
      participant.lastInterim = "";
      if (room.file) {
        const line = `[${new Date().toISOString()}] ${participant.name}: ${t.transcript}\n`;
        await appendFile(room.file, line).catch((e) => console.error("transcript write:", e.message));
      }
    } else {
      participant.lastInterim = t.transcript;
    }
  });
  stt.on("error", (e) => console.error(`STT error (${participant.name}):`, e.message));
  return stt;
}

async function goLive() {
  room.live = true;
  await mkdir(transcriptsDir, { recursive: true });
  room.file = path.join(transcriptsDir, `call-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  const names = [...room.participants.keys()].join(", ");
  await appendFile(room.file, `# Call started ${new Date().toISOString()} — participants: ${names}\n`);
  for (const p of room.participants.values()) p.stt = openStt(p);
  broadcast(roomState());
  console.log(`Call live (${names}) -> ${room.file}`);
}

async function endCall() {
  if (!room.live) return;
  room.live = false;
  const file = room.file;
  const parts = [...room.participants.values()];
  // Ask STT to finalize any in-flight speech, give finals a moment to land.
  for (const p of parts) {
    try { p.stt?.send(JSON.stringify({ endTurn: {} })); } catch {}
  }
  await new Promise((r) => setTimeout(r, 2000));
  for (const p of parts) {
    if (p.lastInterim && file) {
      await appendFile(file, `[${new Date().toISOString()}] ${p.name} (partial): ${p.lastInterim}\n`).catch(() => {});
      p.lastInterim = "";
    }
    try { p.stt?.send(JSON.stringify({ closeStream: {} })); } catch {}
    p.stt?.close();
    p.stt = null;
  }
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
  let me = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "join" && !me) {
      const name = String(msg.name ?? "").trim().slice(0, 32);
      if (!name) return ws.send(JSON.stringify({ type: "error", message: "Name required." }));
      if (room.participants.size >= 2) return ws.send(JSON.stringify({ type: "error", message: "Room is full." }));
      if (room.participants.has(name)) return ws.send(JSON.stringify({ type: "error", message: "Name already taken." }));
      me = { name, ws, stt: null, pendingAudio: [], lastInterim: "" };
      room.participants.set(name, me);
      broadcast(roomState());
      if (room.participants.size === 2) goLive().catch((e) => console.error("goLive:", e.message));
      return;
    }

    if (msg.type === "audio" && me && room.live && msg.data) {
      broadcast({ type: "audio", from: me.name, data: msg.data }, ws);
      broadcast({ type: "level", user: me.name, level: +pcmLevel(msg.data).toFixed(3) });
      if (me.stt?.readyState === WebSocket.OPEN) {
        me.stt.send(JSON.stringify({ audioChunk: { content: msg.data } }));
      } else if (me.pendingAudio.length < 50) {
        me.pendingAudio.push(msg.data);
      }
    }
  });

  ws.on("close", async () => {
    if (!me) return;
    room.participants.delete(me.name);
    await endCall().catch((e) => console.error("endCall:", e.message));
    broadcast(roomState());
  });
});

server.listen(PORT, () => {
  console.log(`Agent "Nova" ready on http://localhost:${PORT} (model: ${MODEL})`);
  console.log(`Text: /  Voice: /voice  Call room: /call`);
});
