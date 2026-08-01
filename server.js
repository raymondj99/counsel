import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = process.env.PORT ?? 3000;
const API_KEY = process.env.INWORLD_API_KEY;
const MODEL = process.env.INWORLD_MODEL ?? "openai/gpt-5.2";
const INWORLD_URL = "https://api.inworld.ai/v1/chat/completions";

const SYSTEM_PROMPT =
  "You are Nova, a friendly and concise assistant shared by a small team. " +
  "You are told which user is speaking at the start of each message. " +
  "Keep replies short and conversational.";

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

server.listen(PORT, () => {
  console.log(`Agent "Nova" ready on http://localhost:${PORT} (model: ${MODEL})`);
  console.log(`Open two tabs and pick a different user in each.`);
});
