// Re-exports the compiled stdb-bridge from game/ during transition.
// Once client/ replaces game/, wire directly to the TypeScript source via Vite.
export { createIronGloveStdb } from '../../game/stdb-bridge.js';
