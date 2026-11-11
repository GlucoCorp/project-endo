/**
 * English strings (spec 21.9): plain words, short sentences, second person for the woman, reading
 * age about 11. No exclamation marks, no emoji, no blame. Buttons say what happens. Every other
 * language provides the same keys; the type makes a missing key a build error.
 */
export const en = {
  'app.name': 'Treatment diary',
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
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Readonly<Record<MessageKey, string>>;
