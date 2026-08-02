"use client";

import { useEffect, useState } from "react";
import styles from "./intake.module.css";
import { scoreIPIP50 } from "../../../intake/schema.js";
import itemBank from "../../../intake/items.json";

const OPTIONS = [
  { value: "", label: "Choose one…" },
  { value: 1, label: "Very inaccurate" },
  { value: 2, label: "Moderately inaccurate" },
  { value: 3, label: "Neither accurate nor inaccurate" },
  { value: 4, label: "Moderately accurate" },
  { value: 5, label: "Very accurate" },
];

export default function IntakePage() {
  const [name, setName] = useState("");
  const [responses, setResponses] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [submittedId, setSubmittedId] = useState(null);

  useEffect(() => {
    const fromQuery = new URLSearchParams(window.location.search).get("name");
    if (fromQuery) setName(fromQuery);
  }, []);

  const complete = name.trim().length > 0 && itemBank.items.every((i) => responses[i.id] != null);

  function setAnswer(id, raw) {
    setResponses((r) => ({ ...r, [id]: raw === "" ? undefined : Number(raw) }));
  }

  async function submit() {
    if (!complete) return;
    setSubmitting(true);
    setError(null);
    try {
      const scoring = scoreIPIP50(itemBank.items, responses);
      const res = await fetch("/api/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), personality: { responses, ...scoring } }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Submission failed (${res.status})`);
      }
      const data = await res.json();
      setSubmittedId(data.intakeId);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="backdrop" />
      <div className="brand">Counsel</div>
      <main className="screen">
        <div className="card">
          {submittedId ? (
            <div className={styles.doneWrap}>
              <div className="title">Thank you.</div>
              <div className="subtitle">Your answers have been recorded.</div>
            </div>
          ) : (
            <>
              <header className="header">
                <div className="welcome">A few quick questions, {name.trim() || "friend"}.</div>
              </header>

              <div className={styles.formBody}>
                <div className={styles.field}>
                  <label htmlFor="intake-name">Your name</label>
                  <input id="intake-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus />
                </div>

                {itemBank.items.map((item) => (
                  <div className={styles.field} key={item.id}>
                    <label htmlFor={`q-${item.id}`}>{item.text}</label>
                    <select
                      id={`q-${item.id}`}
                      className={styles.select}
                      value={responses[item.id] ?? ""}
                      onChange={(e) => setAnswer(item.id, e.target.value)}
                    >
                      {OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}

                {error && <div className={styles.error}>{error}</div>}
              </div>

              <div className="bar">
                <button onClick={submit} disabled={!complete || submitting}>
                  {submitting ? "Submitting…" : "Submit"}
                </button>
              </div>
            </>
          )}
        </div>
      </main>
    </>
  );
}
