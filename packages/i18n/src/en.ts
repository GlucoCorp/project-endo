/**
 * English strings (spec 21.9): plain words, short sentences, second person for the woman, reading
 * age about 11. No exclamation marks, no emoji, no blame. Buttons say what happens. Every other
 * language provides the same keys; the type makes a missing key a build error.
 */
export const en = {
  'app.name': 'Weekly check-in',
  'common.quick-exit': 'Quick exit',
  'common.quick-exit-help': 'Leaves at once and clears this screen.',
  'common.loading': 'Loading',
  'common.try-later': 'Something went wrong on our side. Try again in a minute.',
  'common.too-many': 'Too many tries. Wait a minute, then try again.',

  'enrol.title': 'Set up your treatment diary',
  'enrol.intro':
    'Your clinic uses this diary to see how a treatment is working for you. Setting it up takes about two minutes.',
  'enrol.before-start':
    'Do this at the clinic, on your own phone. Someone at the clinic will check a code with you.',
  'enrol.start': 'Start',
  'enrol.no-link': 'Open the link your clinic gave you to set up your diary.',
  'enrol.link-invalid': 'This link cannot be used. Ask your clinic for a new one.',
  'enrol.locked':
    'Too many wrong codes were typed for this link. Wait 15 minutes, then start again.',
  'enrol.busy': 'This link is being set up on other phones. Wait 15 minutes, then try again.',
  'enrol.unavailable': 'This link is already being used. Ask your clinic if you need help.',

  'enrol.code-title': 'Show this code to the clinic',
  'enrol.code-help':
    'Someone at the clinic types this code to confirm it is you. This page updates by itself.',
  'enrol.code-label': 'Your code',
  'enrol.code-lost':
    'The code is shown in another tab or window. Use that one, or stop and start again for a new code.',
  'enrol.waiting': 'Waiting for the clinic to confirm.',
  'enrol.confirmed': 'The clinic has confirmed it is you. Next, create your sign-in.',
  'enrol.create-sign-in': 'Create your sign-in',
  'enrol.expired': 'This has timed out. Open your link again to start again.',
  'enrol.cancelled': 'Setting up was stopped. Open your link again to start again.',
  'enrol.stop': 'Stop setting up',
  'enrol.stopped': 'Setting up was stopped.',
  'enrol.signing-in': 'Finishing your sign-in.',
  'enrol.signed-in': 'Your sign-in is ready. Next, choose what you share.',

  // Spec 13.1 consent explanations, version 1. DRAFT: needs review by the data protection
  // officer before real use (TODO_LEGAL). A wording change means a new version (consent.ts).
  'consent.step': 'Choice {n} of 4',
  'consent.self_tracking.title': 'Keep your own diary',
  'consent.self_tracking.text':
    'We keep the answers you give each week, so you can see how your treatment is going. Without this, the diary cannot work, and setting up stops here.',
  'consent.self_tracking.grant': 'Keep my diary',
  'consent.self_tracking.decline': 'Do not keep it',
  'consent.share_with_care_team.title': 'Share with your care team',
  'consent.share_with_care_team.text':
    'The care team at your clinic can see your weekly answers and how your treatment is going. You can stop sharing at any time in settings.',
  'consent.share_with_care_team.grant': 'Share with my care team',
  'consent.share_with_care_team.decline': "Don't share",
  'consent.research_deidentified.title': 'Help research',
  'consent.research_deidentified.text':
    'Your answers, with your name and details removed, can help study which treatments work. Nobody can tell the answers are yours.',
  'consent.research_deidentified.grant': 'Include my answers',
  'consent.research_deidentified.decline': "Don't include them",
  'consent.org_aggregate_reporting.title': 'Help your clinic count',
  'consent.org_aggregate_reporting.text':
    'Your clinic sees totals, such as how many people a treatment helped. Your answers are counted, never shown on their own.',
  'consent.org_aggregate_reporting.grant': 'Count my answers',
  'consent.org_aggregate_reporting.decline': "Don't count them",
  'consent.saving': 'Saving your choices.',
  'consent.done': 'Your choices are saved. Your clinic will finish setting up your diary.',
  'consent.declined': 'Setting up was stopped, because the diary needs to keep your answers.',

  'clinic.title': 'Clinic desk',
  'clinic.sign-in': 'Sign in',
  'clinic.signed-out': 'Sign in with your passkey to continue.',
  'clinic.choose-org': 'Choose the organisation you are working for',
  'clinic.org-option': 'Organisation {org}, as {role}',
  'clinic.enrolments-title': 'Confirm a patient',
  'clinic.enrolments-help':
    'Select the invitation for the patient in front of you, then type the code shown on her phone.',
  'clinic.no-invitations': 'There are no open invitations.',
  'clinic.invitation': 'Invitation created {created}, valid until {expires}',
  'clinic.in-use': 'Code confirmed, sign-in in progress',
  'clinic.select': 'Select',
  'clinic.code': 'Code from her phone',
  'clinic.identified': 'I have identified her the way this clinic normally does.',
  'clinic.own-phone': 'I read the code from her own phone.',
  'clinic.confirm': 'Confirm',
  'clinic.confirmed': 'Confirmed. She can now create her sign-in on her phone.',
  'clinic.wrong':
    'That code does not match. {remaining} more tries before this invitation is locked for 15 minutes.',
  'clinic.locked': 'Too many wrong codes. This invitation is locked until {time}.',
  'clinic.unavailable': 'This invitation can no longer be used. Create a new one for her.',
  'clinic.attest-required': 'Both statements must be true to confirm.',
  'clinic.code-format': 'The code is six digits.',
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Readonly<Record<MessageKey, string>>;
