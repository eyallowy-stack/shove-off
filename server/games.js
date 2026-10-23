// Every online game this server runs, by the id in its URL: /room/<game>/<code>.
// Adding a game later is one line here plus its rules module.

import { shoveRules } from '../js/game/rules.js';

export const GAMES = {
  shove: shoveRules,
};
