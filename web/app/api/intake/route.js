import { mkdir, appendFile, readFile } from "node:fs/promises";
import path from "node:path";

// Repo root, one level up from web/ (matches transcripts/ and
// decision_engine/sessions/, which also live at the repo root).
const SUBMISSIONS_DIR = path.join(process.cwd(), "..", "intake", "submissions");
const SUBMISSIONS_FILE = path.join(SUBMISSIONS_DIR, "submissions.jsonl");

export async function GET() {
  let raw;
  try {
    raw = await readFile(SUBMISSIONS_FILE, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return Response.json({ submissions: [] });
    throw err;
  }
  const submissions = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map(({ intakeId, name, submittedAt, personality }) => ({ intakeId, name, submittedAt, personality }));
  return Response.json({ submissions });
}

export async function POST(request) {
  const body = await request.json();

  if (!body?.name || !body?.personality) {
    return Response.json({ error: "incomplete submission" }, { status: 400 });
  }

  const record = {
    intakeId: crypto.randomUUID(),
    submittedAt: new Date().toISOString(),
    ...body,
  };

  await mkdir(SUBMISSIONS_DIR, { recursive: true });
  await appendFile(SUBMISSIONS_FILE, `${JSON.stringify(record)}\n`, "utf8");

  return Response.json({ ok: true, intakeId: record.intakeId });
}
