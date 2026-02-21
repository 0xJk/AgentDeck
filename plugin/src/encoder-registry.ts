/**
 * Registry for encoder action IDs.
 * Breaks circular dependency between encoder-takeover.ts and action modules.
 * Each action module registers its IDs here; encoder-takeover reads from here.
 *
 * 4-encoder layout: E1=Utility | E2=Option | E3=Command | E4=Voice
 *   Takeover: utilityIds=Context | optionIds=Focus | commandIds=List p1 | voiceIds=List p2
 *
 * 3-encoder layout: E1=other | E2=Option | E3=Command | E4=Voice
 *   Takeover: optionIds=Focus | commandIds=List | voiceIds=Context | contextIds=List p2
 */
export const encoderRegistry = {
  utilityIds: [] as string[],  // Utility Dial    — takeover: Context view (4-encoder mode)
  optionIds: [] as string[],   // Option Selector — takeover: Focus view
  commandIds: [] as string[],  // Quick Command   — takeover: List view (adjacent to focus)
  voiceIds: [] as string[],    // Voice Input     — takeover: Context view (3-enc) / List p2 (4-enc)
  contextIds: [] as string[],  // Context Display — takeover: List page 2 (optional, 3-enc only)
};
