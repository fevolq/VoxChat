/** Shared, versioned protocol constants; the mobile clients are separate projects. */
export const PREFIX = '/voxchat';
export const API = PREFIX + '/api';
export const PROTOCOL = 2;
export const CAPABILITIES = ['asr', 'tts', 'summary'];
export const LIMITS = Object.freeze({
  audioBytes: 25 * 1024 * 1024,
  jsonBytes: 64 * 1024,
  uploadMs: 60_000,
  turnMs: 10 * 60_000,
  providerMs: 120_000,
  pairingMs: 5 * 60_000,
  summaryChars: 800,
});
