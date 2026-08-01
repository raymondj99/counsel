"use client";

import { useEffect, useRef, useState } from "react";

const WS_URL = process.env.NEXT_PUBLIC_CALL_WS ?? "ws://localhost:3000/callws";

export default function Home() {
  const [name, setName] = useState("");
  const [joined, setJoined] = useState(false);
  const [live, setLive] = useState(false);
  const [muted, setMuted] = useState(false);
  const [status, setStatus] = useState("");
  const [caption, setCaption] = useState(null);
  const [elapsed, setElapsed] = useState(0);

  const wsRef = useRef(null);
  const mutedRef = useRef(false);
  const liveRef = useRef(false);
  const orbRef = useRef(null);
  const levelRef = useRef(0);
  const audioRef = useRef({ nextPlayTime: 0 });

  mutedRef.current = muted;
  liveRef.current = live;

  /* The orb inherits the painting's most saturated color (deep blue, pink…):
     bucket pixels by hue, keep only vivid ones, pick the richest bucket. */
  useEffect(() => {
    const img = new Image();
    img.src = "/monet.jpg";
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = 80;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, 80, 80);
      const d = ctx.getImageData(0, 0, 80, 80).data;

      const buckets = new Map(); // hue band -> {score, h, s, l, n}
      for (let i = 0; i < d.length; i += 4) {
        const [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
        if (s < 0.25 || l < 0.12 || l > 0.85) continue; // skip muddy/washed pixels
        const key = Math.round(h / 20) * 20;
        const b = buckets.get(key) ?? { score: 0, h: 0, s: 0, l: 0, n: 0 };
        const w = s * s; // favor vividness
        b.score += w; b.h += h * w; b.s += s * w; b.l += l * w; b.n += w;
        buckets.set(key, b);
      }
      const best = [...buckets.values()].sort((a, b) => b.score - a.score)[0];
      if (!best) return;
      const h = best.h / best.n;
      const s = Math.min(0.75, best.s / best.n + 0.15); // push saturation up
      const l = best.l / best.n;
      const root = document.documentElement.style;
      root.setProperty("--orb-a", `hsl(${h}, ${s * 100}%, ${Math.min(82, l * 100 + 26)}%)`);
      root.setProperty("--orb-b", `hsl(${h}, ${s * 100}%, ${l * 100}%)`);
      root.setProperty("--orb-c", `hsl(${h}, ${s * 100}%, ${Math.max(16, l * 100 - 18)}%)`);
    };
  }, []);

  /* Orb animation: gentle breathing, swells with whoever is speaking. */
  useEffect(() => {
    let raf;
    let smooth = 0;
    const tick = (t) => {
      levelRef.current *= 0.9;
      smooth += (Math.min(1, levelRef.current * 7) - smooth) * 0.18;
      const breath = liveRef.current ? Math.sin(t / 1100) * 0.015 : Math.sin(t / 2600) * 0.006;
      if (orbRef.current) {
        orbRef.current.style.transform = `scale(${1 + breath + smooth * 0.16})`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  /* Call timer. */
  useEffect(() => {
    if (!live) return;
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(id);
  }, [live]);

  async function join() {
    if (!name.trim()) return;
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", name: name.trim() }));
    ws.onclose = () => { setLive(false); setStatus("Disconnected."); stopAudio(audioRef.current); };
    ws.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "error") setStatus(msg.message);
      if (msg.type === "room") {
        if (msg.live) {
          setLive(true);
          setStatus("");
          await startAudio(audioRef.current, ws, mutedRef, levelRef);
        } else {
          setLive(false);
          setStatus(msg.participants.length < 2 ? "Waiting for the second participant…" : "");
        }
      }
      if (msg.type === "audio") playRemote(audioRef.current, msg.data);
      if (msg.type === "level") levelRef.current = Math.max(levelRef.current, msg.level);
      if (msg.type === "transcript") setCaption({ who: msg.user, text: msg.text });
      if (msg.type === "ended") setStatus(`Call ended. Transcript saved${msg.file ? `: transcripts/${msg.file}` : "."}`);
    };
    setJoined(true);
    setStatus("Joining…");
  }

  function endCall() {
    wsRef.current?.close();
    stopAudio(audioRef.current);
    setLive(false);
    setJoined(false);
    setCaption(null);
    setElapsed(0);
    setStatus("");
  }

  const mmss = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;

  return (
    <>
      <div className="backdrop" />
      <main className="screen">
        <div className="card">
        <header className="header">
          <div className="title">{joined && live ? `${name} ${mmss}` : "Counsel"}</div>
          <div className="subtitle">{status || "a quiet place to talk"}</div>
        </header>

        <div className="orbWrap">
          <div ref={orbRef} className={`orb${live ? "" : " off"}`} />
          <div className="caption">
            {caption && (
              <>
                <span className="who">{caption.who}: </span>
                {caption.text}
              </>
            )}
          </div>
        </div>

        {joined ? (
          <div className="bar">
            <button onClick={() => setMuted((m) => !m)}>
              <span className={`mic${muted ? " muted" : ""}`}>&#127908;</span>
              {muted ? "Unmute" : "Mute"}
            </button>
            <button onClick={endCall}>
              <span className="dot" /> End call
            </button>
          </div>
        ) : (
          <div className="join">
            <input
              placeholder="Your name"
              maxLength={32}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && join()}
            />
            <button onClick={join}>Join call</button>
          </div>
        )}
        </div>
      </main>
    </>
  );
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const dlt = max - min;
  const s = l > 0.5 ? dlt / (2 - max - min) : dlt / (max + min);
  let h;
  if (max === r) h = ((g - b) / dlt + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / dlt + 2) * 60;
  else h = ((r - g) / dlt + 4) * 60;
  return [h, s, l];
}

/* ── audio: 16kHz PCM capture + scheduled playback (room protocol) ── */

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  return btoa(bin);
}

async function startAudio(a, ws, mutedRef, levelRef) {
  a.stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  a.playbackCtx = new AudioContext({ sampleRate: 16000 });
  if (a.playbackCtx.state === "suspended") await a.playbackCtx.resume();
  a.captureCtx = new AudioContext({ sampleRate: 16000 });
  const source = a.captureCtx.createMediaStreamSource(a.stream);
  const code = `class P extends AudioWorkletProcessor{constructor(){super();this.b=[];this.n=0}process(inp){const c=inp[0]?.[0];if(!c)return true;const p=new Int16Array(c.length);for(let i=0;i<c.length;i++){const s=Math.max(-1,Math.min(1,c[i]));p[i]=s<0?s*0x8000:s*0x7FFF}this.b.push(p);this.n+=p.length;if(this.n>=1600){const o=new Int16Array(this.n);let f=0;for(const x of this.b){o.set(x,f);f+=x.length}this.b=[];this.n=0;this.port.postMessage(o.buffer,[o.buffer])}return true}}registerProcessor('pcm',P)`;
  const url = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
  await a.captureCtx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  a.worklet = new AudioWorkletNode(a.captureCtx, "pcm");
  a.worklet.port.onmessage = (e) => {
    if (mutedRef.current || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "audio", data: b64(e.data) }));
  };
  source.connect(a.worklet);
}

function playRemote(a, base64) {
  if (!a.playbackCtx) return;
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pcm16 = new Int16Array(bytes.buffer);
  const f32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) f32[i] = pcm16[i] / 32768;
  const buf = a.playbackCtx.createBuffer(1, f32.length, 16000);
  buf.getChannelData(0).set(f32);
  const src = a.playbackCtx.createBufferSource();
  src.buffer = buf;
  src.connect(a.playbackCtx.destination);
  const now = a.playbackCtx.currentTime;
  if (a.nextPlayTime < now) a.nextPlayTime = now;
  src.start(a.nextPlayTime);
  a.nextPlayTime += buf.duration;
}

function stopAudio(a) {
  a.worklet?.disconnect();
  a.captureCtx?.close();
  a.stream?.getTracks().forEach((t) => t.stop());
  a.playbackCtx?.close();
  a.worklet = a.captureCtx = a.stream = a.playbackCtx = null;
  a.nextPlayTime = 0;
}
