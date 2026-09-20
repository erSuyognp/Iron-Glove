// Central AI feature flags. The game must run with every flag false.
// Adaptive difficulty and the flight assistant are wired later; they stay off
// until Feature B / C land.

export const AI_FEATURES = {
  rlSentinel: true,
  adaptiveDifficulty: false,
  flightAssistant: false,
  /** Extra SENTINEL AI / AI DECISION HUD rows. */
  debugHud: true,
};

/** Policy inference rate. Rendering stays at display framerate. */
export const SENTINEL_INFER_HZ = 15;
