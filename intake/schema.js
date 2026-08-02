// intake/schema.js
// Contract between the intake form (UI) and the counsel engine.
// The form owns collection. This file owns scoring, validation, and the exact
// shape the engine receives. Neither side should reach across.

export const SCHEMA_VERSION = 'intake-v1';

// IPIP-50 (Goldberg's 50-item Big-Five Factor Markers). 5-point Likert, 1-5.
// 10 items per domain => raw domain range 10-50.
export const LIKERT_MIN = 1;
export const LIKERT_MAX = 5;
export const ITEMS_PER_DOMAIN = 10;

export const DOMAINS = [
  'extraversion',
  'agreeableness',
  'conscientiousness',
  'emotional_stability',
  'openness',
];

// Band cutoffs used throughout the eval set.
export const BANDS = { low: [10, 23], medium: [24, 36], high: [37, 50] };

export function band(score) {
  if (score <= BANDS.low[1]) return 'low';
  if (score >= BANDS.high[0]) return 'high';
  return 'medium';
}

/**
 * Item bank lives in intake/items.json, NOT here.
 *
 * Populate it from ipip.ori.org (IPIP items are public domain). Each row:
 *   { "id": 1, "domain": "extraversion", "keyed": "+", "text": "..." }
 *
 * VERIFY THE KEYING before you trust any score. The reverse-keyed items are
 * the single easiest thing to get wrong, and a flipped key silently inverts a
 * whole domain — you'd ship an engine that reads an anxious partner as stable.
 * Cross-check: administer the form to yourself twice, once answering all 5s.
 * All-5s should produce lopsided, not uniform, domain scores.
 */

/**
 * @param {Array<{id:number,domain:string,keyed:'+'|'-'}>} items
 * @param {Record<number, number>} responses  itemId -> 1..5
 * @returns {{scores:object, bands:object, completeness:number, warnings:string[]}}
 */
export function scoreIPIP50(items, responses) {
  const warnings = [];
  const totals = Object.fromEntries(DOMAINS.map((d) => [d, { sum: 0, n: 0 }]));

  for (const item of items) {
    if (!DOMAINS.includes(item.domain)) {
      warnings.push(`item ${item.id}: unknown domain "${item.domain}"`);
      continue;
    }
    const raw = responses[item.id];
    if (raw == null) continue;
    if (!Number.isInteger(raw) || raw < LIKERT_MIN || raw > LIKERT_MAX) {
      warnings.push(`item ${item.id}: response ${raw} outside 1-5`);
      continue;
    }
    // Reverse-keyed: 6 - raw on a 1-5 scale.
    const value = item.keyed === '-' ? LIKERT_MIN + LIKERT_MAX - raw : raw;
    totals[item.domain].sum += value;
    totals[item.domain].n += 1;
  }

  const scores = {};
  for (const d of DOMAINS) {
    const { sum, n } = totals[d];
    if (n === 0) {
      scores[d] = null;
      warnings.push(`${d}: no responses`);
    } else if (n < ITEMS_PER_DOMAIN) {
      // Prorate rather than drop — but say so loudly, since a 4-item domain
      // score is not comparable to a 10-item one.
      scores[d] = Math.round((sum / n) * ITEMS_PER_DOMAIN);
      warnings.push(`${d}: only ${n}/${ITEMS_PER_DOMAIN} answered, score prorated`);
    } else {
      scores[d] = sum;
    }
  }

  const answered = Object.keys(responses).length;
  return {
    scores,
    bands: Object.fromEntries(DOMAINS.map((d) => [d, scores[d] == null ? null : band(scores[d])])),
    completeness: +(answered / items.length).toFixed(3),
    warnings,
  };
}

/** Straight-lining / inattention check. Run before trusting a submission. */
export function responseQuality(responses) {
  const vals = Object.values(responses).filter((v) => Number.isInteger(v));
  if (vals.length < 10) return { ok: false, reason: 'too few responses' };
  const uniq = new Set(vals).size;
  const mode = vals.sort((a, b) =>
    vals.filter((v) => v === b).length - vals.filter((v) => v === a).length)[0];
  const modeShare = vals.filter((v) => v === mode).length / vals.length;
  if (uniq <= 2) return { ok: false, reason: 'straight-lining: <=2 distinct values' };
  if (modeShare > 0.7) return { ok: false, reason: `${Math.round(modeShare * 100)}% same answer` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The engine boundary. This is the important part.
// ---------------------------------------------------------------------------

/**
 * Builds the engine input for one partner.
 *
 * personality_type is the ONLY thing the engine sees. Anything the form
 * collects about attachment style, therapy history, or presenting problem goes
 * in `context` and stays out of the model prompt — it's for scenario design and
 * clinician review. The eval set makes the same split (clinical_context is
 * documented as "narrative grounding only, NOT part of the engine's input
 * schema"), so keeping it here means intake and eval agree by construction
 * instead of by anyone remembering to.
 */
export function toPartnerProfile({ name, scores, context = {} }) {
  return {
    name,
    personality_type: {
      openness: scores.openness,
      conscientiousness: scores.conscientiousness,
      extraversion: scores.extraversion,
      agreeableness: scores.agreeableness,
      emotional_stability: scores.emotional_stability,
    },
    _context: context, // underscore = never serialize into a prompt
  };
}

/** Final payload handed to the engine. Strips everything private. */
export function toEngineInput({ partnerA, partnerB, situation }) {
  const strip = (p) => ({ name: p.name, personality_type: p.personality_type });
  return {
    schemaVersion: SCHEMA_VERSION,
    situation,
    partner_A: strip(partnerA),
    partner_B: strip(partnerB),
  };
}

/** Throws if a submission isn't safe to send downstream. */
export function validateIntake(partner) {
  const errs = [];
  if (!partner?.name) errs.push('missing name');
  for (const d of DOMAINS) {
    const v = partner?.personality_type?.[d];
    if (typeof v !== 'number') errs.push(`${d}: not scored`);
    else if (v < 10 || v > 50) errs.push(`${d}: ${v} outside 10-50`);
  }
  if (errs.length) throw new Error(`intake invalid: ${errs.join('; ')}`);
  return true;
}
