/**
 * Thin paste indirection for voice routing.
 *
 * Re-exports the single clipboard primitive voice-dial needs. Keeping this in a
 * dedicated module (instead of importing pasteText straight from ./macos) lets
 * unit tests mock the local-paste path without pulling macos.ts into the mocked
 * module graph — macos.ts embeds Unicode-property-escape regexes that the test
 * mock-transform pipeline cannot re-parse.
 */
export { pasteText } from './macos.js';
