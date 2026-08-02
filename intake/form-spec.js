// intake/form-spec.js
// Single source of truth for intake content. UI-agnostic — render it however.
//
// NOTE ON THE BRIEF: the spec says "6 questions about situation" and then lists
// nine. Nine are implemented here. Confirm which is intended before you field it,
// because question count drives the drop-off estimate and the time-to-complete
// copy on the first screen.

export const SPEC_VERSION = 'intake-form-v1';

export const SECTIONS = [
  {
    id: 'personality',
    title: 'How you tend to be',
    eyebrow: 'Part one',
    lede: 'Fifty short statements. Answer for how you generally are, not how you are this week. There are no better or worse answers here.',
    disclosure: 'Scored automatically. Your partner never sees your individual answers.',
    kind: 'ipip50',
    // Items load from intake/items.json. See intake/schema.js for scoring.
    source: 'items.json',
  },

  {
    id: 'situation',
    title: 'What is happening',
    eyebrow: 'Part two',
    lede: 'Answer in your own words. Longer is not better — specific is better.',
    disclosure: 'Read by your clinician. Shared with your partner only if you both agree, later.',
    kind: 'questions',
    questions: [
      {
        id: 'main_problem',
        type: 'long_text',
        label: 'What is the main relationship problem from your perspective?',
        minChars: 40,
      },
      {
        id: 'why_now',
        type: 'long_text',
        label: 'Why are you seeking help now?',
        help: 'Did something recently change or happen?',
        minChars: 30,
      },
      {
        id: 'recent_interaction',
        type: 'long_text',
        label: 'Describe one recent interaction that represents the problem.',
        help: 'What happened, what did you feel, what did you do, and what did your partner do?',
        minChars: 80,
        // The single most useful field in the whole form. Four sub-parts, so the
        // UI should show them as a visible checklist rather than one blank box.
        scaffold: ['What happened', 'What you felt', 'What you did', 'What your partner did'],
      },
      {
        id: 'usual_pattern',
        type: 'multi_select',
        label: 'What usually happens when this problem arises?',
        help: 'Choose what fits you. Most people do more than one.',
        // These labels are not arbitrary — they map onto documented conflict
        // behaviours (Gottman's four horsemen plus the demand-withdraw pattern).
        // Keeping them as a fixed vocabulary instead of free text is what makes
        // this answer usable downstream and comparable across both partners.
        options: [
          { value: 'pursue', label: 'I keep pressing to talk about it' },
          { value: 'criticize', label: 'I criticise them' },
          { value: 'defend', label: 'I defend myself' },
          { value: 'explain', label: 'I explain my reasoning' },
          { value: 'withdraw', label: 'I go quiet or leave the room' },
          { value: 'shut_down', label: 'I shut down completely' },
          { value: 'appease', label: 'I smooth it over to end it' },
          { value: 'leave', label: 'I leave for a while' },
        ],
        allowOther: true,
      },
      {
        id: 'wish_understood',
        type: 'long_text',
        label: 'What do you wish your partner understood about you in these moments?',
        minChars: 30,
      },
      {
        id: 'own_contribution',
        type: 'long_text',
        label: 'What might you be doing that contributes to the pattern?',
        help: 'Answering this honestly is the strongest single predictor that this work will help.',
        minChars: 30,
      },
      {
        id: 'already_tried',
        type: 'long_text',
        label: 'What have you already tried, and what happened?',
        minChars: 30,
      },
      {
        id: 'therapy_goal',
        type: 'single_select',
        label: 'What do you want from therapy?',
        options: [
          { value: 'improve', label: 'Improve the relationship' },
          { value: 'decide', label: 'Decide whether to stay together' },
          { value: 'separate', label: 'Separate constructively' },
          { value: 'coparent', label: 'Improve co-parenting' },
          { value: 'unsure', label: 'Unsure' },
        ],
        // Partners choosing differently here is itself a finding. Never resolve
        // it silently to the more common answer.
      },
      {
        id: 'ratings',
        type: 'scale_group',
        label: 'Rate each from 0 to 10.',
        scales: [
          { id: 'satisfaction', label: 'Current relationship satisfaction', low: 'Very low', high: 'Very high' },
          { id: 'motivation', label: 'Motivation to improve the relationship', low: 'None', high: 'Complete' },
          { id: 'confidence', label: 'Confidence that change is possible', low: 'None', high: 'Complete' },
        ],
      },
    ],
  },

  {
    id: 'safety',
    title: 'Before we go further',
    eyebrow: 'Part three',
    lede: 'Three questions we ask everyone. Your answers here are handled differently from the rest of the form.',
    // This wording is load-bearing. Say what happens BEFORE they answer, not after.
    disclosure: 'Read only by a member of our clinical team. Never shown to your partner, and never used for automated analysis.',
    kind: 'questions',
    confidential: true,
    questions: [
      {
        id: 'partner_safety',
        type: 'yes_no_unsure',
        label: 'Do you currently feel afraid of, controlled by, or physically or sexually unsafe with your partner?',
        triggersReview: ['yes', 'unsure'],
      },
      {
        id: 'harm_risk',
        type: 'yes_no_unsure',
        label: 'Have you recently considered harming yourself, your partner, or anyone else?',
        triggersReview: ['yes', 'unsure'],
        // On a positive answer the UI shows support options immediately, in the
        // same screen. Do not wait for submit — the person may never submit.
        showSupportOnPositive: true,
      },
      {
        id: 'contact_safe',
        type: 'yes_no',
        label: 'Is it safe for us to contact you using the details you gave us?',
        help: 'If not, tell us how to reach you instead.',
        triggersReview: ['no'],
        followUp: { id: 'alt_contact', type: 'short_text', label: 'A safer way to reach you', showWhen: 'no' },
      },
    ],
  },
];

// Shown inline the moment someone answers positively to harm_risk, and on the
// confirmation screen for any triggered review. US numbers — swap per region.
export const SUPPORT_RESOURCES = [
  {
    name: '988 Suicide & Crisis Lifeline',
    detail: 'Call or text 988. Free, 24 hours.',
    href: 'tel:988',
  },
  {
    name: 'National Domestic Violence Hotline',
    detail: 'Call 1-800-799-7233, or text START to 88788.',
    href: 'tel:18007997233',
  },
];

export const QUIET_EXIT_URL = 'https://www.google.com';
