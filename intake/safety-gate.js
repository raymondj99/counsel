// intake/safety-gate.js
// Enforces the rule structurally, not by convention.
//
// Conjoint (couple-level) work is contraindicated when there is active fear,
// coercive control, or risk of harm — joint sessions can escalate danger to the
// person who disclosed. So a positive screen must not merely be *logged*; it
// must make the couple-level path unreachable.
//
// The mechanism: toEngineInput() in schema.js should require a clearance token
// that only this module issues, and this module only issues one when the screen
// is clear. A missing token is a thrown error, not a silent pass.

import crypto from 'node:crypto';

export const REVIEW_ROUTE = 'confidential_human_review';
export const STANDARD_ROUTE = 'standard_intake';

/**
 * @param {Record<string,string>} answers  safety section answers, e.g.
 *   { partner_safety: 'no', harm_risk: 'no', contact_safe: 'yes' }
 * @returns {{route:string, triggers:string[], complete:boolean}}
 */
export function screen(answers = {}) {
  const triggers = [];

  if (['yes', 'unsure'].includes(answers.partner_safety)) {
    triggers.push({
      question: 'partner_safety',
      answer: answers.partner_safety,
      // Severity is for triage ordering only. It is NOT a threshold — every
      // trigger routes to human review regardless.
      concern: 'fear / coercive control disclosed or uncertain',
    });
  }

  if (['yes', 'unsure'].includes(answers.harm_risk)) {
    triggers.push({
      question: 'harm_risk',
      answer: answers.harm_risk,
      concern: 'risk of harm to self or others disclosed or uncertain',
    });
  }

  if (answers.contact_safe === 'no') {
    triggers.push({
      question: 'contact_safe',
      answer: 'no',
      concern: 'contact details unsafe — do not use stored contact info',
    });
  }

  const complete = ['partner_safety', 'harm_risk', 'contact_safe'].every((k) => answers[k] != null);

  return {
    route: triggers.length ? REVIEW_ROUTE : STANDARD_ROUTE,
    triggers,
    complete,
    // "unsure" routes to review too. A form that only catches "yes" misses the
    // people most worth catching, because ambivalence is the common presentation.
    unsureCount: Object.values(answers).filter((v) => v === 'unsure').length,
  };
}

const CLEARANCES = new Map();

/**
 * Issues a clearance token, or null. Null means the couple-level engine is
 * unreachable for this intake — by construction, not by policy.
 */
export function issueClearance(intakeId, answers) {
  const result = screen(answers);
  if (!result.complete || result.route !== STANDARD_ROUTE) {
    CLEARANCES.delete(intakeId);
    return { token: null, ...result };
  }
  const token = crypto.randomBytes(16).toString('hex');
  CLEARANCES.set(intakeId, { token, issuedAt: Date.now() });
  return { token, ...result };
}

export function verifyClearance(intakeId, token) {
  const rec = CLEARANCES.get(intakeId);
  return !!(rec && token && rec.token === token);
}

/**
 * Strips everything the engine must never see. Call this on the way out of
 * storage, not on the way in — you still want the full record for the clinician.
 */
export function redactForEngine(intake) {
  const { safety, contact, alt_contact, ...rest } = intake;
  return rest;
}

/**
 * Builds the clinician-facing packet for a triggered review.
 * Deliberately does NOT include the other partner's submission: reviewing them
 * side by side is how a disclosure ends up paraphrased back into a joint session.
 */
export function reviewPacket(intake, screenResult) {
  return {
    intakeId: intake.intakeId,
    submittedAt: intake.submittedAt,
    personName: intake.name,
    route: screenResult.route,
    triggers: screenResult.triggers,
    contactSafe: intake.safety?.contact_safe !== 'no',
    preferredContact:
      intake.safety?.contact_safe === 'no' ? intake.alt_contact ?? '(none given)' : intake.contact,
    // Free-text situation answers often contain the detail that matters. Include
    // them; this packet is going to a clinician, not a model.
    situation: intake.situation ?? null,
    partnerSubmissionIncluded: false,
  };
}
