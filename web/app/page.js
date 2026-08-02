"use client";

import { useEffect, useRef, useState } from "react";

const WS_URL = process.env.NEXT_PUBLIC_CALL_WS ?? "ws://localhost:3000/callws";

export default function Home() {
  const [nameA, setNameA] = useState("Maya");
  const [nameB, setNameB] = useState("Dev");
  const [joined, setJoined] = useState(false);
  const [live, setLive] = useState(false);
  const [muted, setMuted] = useState(false);
  const [status, setStatus] = useState("");
  const [caption, setCaption] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [intakeSubmissions, setIntakeSubmissions] = useState([]);

  const wsRef = useRef(null);
  const mutedRef = useRef(false);
  const liveRef = useRef(false);
  const orbRef = useRef(null);
  const levelRef = useRef(0);
  const audioRef = useRef({ nextPlayTime: 0 });

  mutedRef.current = muted;
  liveRef.current = live;

  /* Orb wears one of three saturated coats: light green, lily pink, sky blue. */
  useEffect(() => {
    const palettes = [
      { a: "#e6e9c8", b: "#c9cf9c", c: "#a2a96f" }, // pastel olive green
      { a: "#f7d8e1", b: "#eebac9", c: "#d495a9" }, // pastel pink
      { a: "#d3e9f8", b: "#aed4ee", c: "#84b3d4" }, // pastel sky blue
    ];
    const p = palettes[Math.floor(Math.random() * palettes.length)];
    const root = document.documentElement.style;
    root.setProperty("--orb-a", p.a);
    root.setProperty("--orb-b", p.b);
    root.setProperty("--orb-c", p.c);
  }, []);

  /* Orb animation: gentle breathing, swells with whoever is speaking. */
  useEffect(() => {
    let raf;
    let smooth = 0;
    const tick = (t) => {
      levelRef.current *= 0.9;
      smooth += (Math.min(1, levelRef.current * 7) - smooth) * 0.18;
      // Meditative pulse: ~5s cycle, deeper when idle, subtler mid-call.
      const breath = Math.sin(t / 800) * (liveRef.current ? 0.03 : 0.055);
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

  /* Intake responses: loaded on mount, and re-checked whenever the tab
     regains focus (e.g. after filling out the intake form in a new tab). */
  useEffect(() => {
    async function loadIntake() {
      try {
        const res = await fetch("/api/intake");
        const data = await res.json();
        setIntakeSubmissions(data.submissions ?? []);
      } catch {
        // Intake status is a nice-to-have on this screen; ignore failures.
      }
    }
    loadIntake();
    window.addEventListener("focus", loadIntake);
    return () => window.removeEventListener("focus", loadIntake);
  }, []);

  function intakeFor(partnerName) {
    const target = partnerName.trim().toLowerCase();
    if (!target) return null;
    const matches = intakeSubmissions.filter((s) => s.name.trim().toLowerCase() === target);
    return matches[matches.length - 1] ?? null;
  }

  async function join() {
    if (!nameA.trim() || !nameB.trim()) return;
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", names: [nameA.trim(), nameB.trim()] }));
    ws.onclose = () => { setLive(false); setStatus("Disconnected."); stopAudio(audioRef.current); };
    ws.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "error") setStatus(msg.message);
      if (msg.type === "room" && msg.live) {
        setLive(true);
        setStatus("");
        await startAudio(audioRef.current, ws, mutedRef, levelRef);
      }
      if (msg.type === "audio") playRemote(audioRef.current, msg.data);
      if (msg.type === "level") levelRef.current = Math.max(levelRef.current, msg.level);
      if (msg.type === "transcript") setCaption(msg.text ? { who: msg.user, text: msg.text } : null);
      if (msg.type === "ended") setStatus(`Call ended. Transcript saved${msg.file ? `: transcripts/${msg.file}` : "."}`);
    };
    setJoined(true);
    setStatus("Starting…");
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
      <div className="brand">Counsel</div>
      <main className="screen">
        <div className="card">
        <header className="header">
          {joined && live ? (
            <div className="title">{nameA.trim()} &amp; {nameB.trim()} {mmss}</div>
          ) : (
            <div className="welcome">
              Welcome, {nameA.trim() || "Maya"} &amp; {nameB.trim() || "Dev"}. Find a quiet place to talk together.
            </div>
          )}
          {status && <div className="subtitle">{status}</div>}
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
            <div className="joinRow">
              <PartnerColumn name={nameA} setName={setNameA} placeholder="Maya" onEnter={join} intake={intakeFor(nameA)} />
              <PartnerColumn name={nameB} setName={setNameB} placeholder="Dev" onEnter={join} intake={intakeFor(nameB)} />
            </div>
            <button onClick={join}>Start session</button>
          </div>
        )}
        </div>
      </main>
    </>
  );
}

function PartnerColumn({ name, setName, placeholder, onEnter, intake }) {
  const trimmed = name.trim();
  return (
    <div className="partnerCol">
      <input
        placeholder={placeholder}
        maxLength={32}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onEnter()}
      />
      <button
        type="button"
        className="intakeBtn"
        disabled={!trimmed}
        onClick={() => window.open(`/intake?name=${encodeURIComponent(trimmed)}`, "_blank", "noopener,noreferrer")}
      >
        Take intake
      </button>
      {intake && <IntakeSummary intake={intake} />}
    </div>
  );
}

function IntakeSummary({ intake }) {
  const bands = intake.personality?.bands ?? {};
  return (
    <div className="intakeSummary">
      <div className="intakeDone">✓ Intake completed</div>
      {Object.entries(bands).map(([domain, band]) => (
        <div className="intakeLine" key={domain}>
          <span>{domain.replace("_", " ")}</span>
          <span>{band ?? "—"}</span>
        </div>
      ))}
    </div>
  );
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
