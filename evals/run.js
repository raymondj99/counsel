// Offline A/B runner for the mediator's LLM step.
//
// Replays a canned transcript (a fixture) through one or more prompt files using
// the SAME state-building, prompt assembly, and decision logic the live server
// uses (see ./mediator.js). Use it to compare how different prompts respond to
// an identical conversation before shipping them to live traffic.
//
// Usage:
//   node evals/run.js [fixture.json] [promptA.md promptB.md ...]
//
// Defaults: fixture = evals/fixtures/sample.json, prompt = evals/mediator-prompt.md
//
// With INWORLD_API_KEY set, it calls the LLM and prints each prompt's decision.
// Without a key, it does a dry run and prints the assembled messages so you can
// eyeball exactly what each prompt would send.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createState,
  addTurn,
  updateEmotionContext,
  buildMessages,
  callLLM,
  parseDecision,
  loadPrompt,
  DEFAULT_PROMPT_FILE,
} from "./mediator.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.INWORLD_API_KEY;
const MODEL = process.env.INWORLD_MODEL ?? "openai/gpt-4o-mini";

const [, , fixtureArg, ...promptArgs] = process.argv;
const fixtureFile = fixtureArg ?? path.join(HERE, "fixtures", "sample.json");
const promptFiles = promptArgs.length ? promptArgs : [DEFAULT_PROMPT_FILE];

// Rebuild conversation state from a fixture, exactly as the live server would.
function stateFromFixture(fixture) {
  const state = createState();
  Object.assign(state.context, fixture.context ?? {});
  for (const turn of fixture.turns ?? []) {
    addTurn(state, turn.speaker, turn.text, { emotion: turn.emotion ?? null });
    updateEmotionContext(state, turn.emotion);
  }
  return state;
}

async function main() {
  const fixture = JSON.parse(await readFile(fixtureFile, "utf8"));
  console.log(`Fixture: ${fixtureFile}  (${(fixture.turns ?? []).length} turns)\n`);

  for (const file of promptFiles) {
    const systemPrompt = await loadPrompt(file, "");
    const state = stateFromFixture(fixture);
    const messages = buildMessages(systemPrompt, state);

    console.log(`──────────────────────────────────────────────`);
    console.log(`Prompt: ${file}`);
    if (!API_KEY) {
      console.log("(dry run — no INWORLD_API_KEY; showing assembled messages)");
      console.log(JSON.stringify(messages, null, 2));
      continue;
    }
    try {
      const reply = await callLLM({ messages, apiKey: API_KEY, model: MODEL });
      const decision = parseDecision(reply);
      console.log(decision.speak ? `SPEAK: ${decision.text}` : "PASS (stays silent)");
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
