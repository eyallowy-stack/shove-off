// A match on this device: two players on one keyboard (or two pads), or one
// player against the CPU (js/game/cpu.js). Runs the very rules the room server runs, at the same
// 60 Hz tick, so local and online play feel identical.

import { createDuel } from './game/rules.js';
import { createCpu } from './game/cpu.js';
import { K, PH } from './game/sim.js';

// mode: '2p' (one keyboard or two pads), 'cpu' (you are Coral, the CPU is Teal at
// `level`), or 'demo' (two CPUs behind the title). The CPU's input goes into the
// same duel.step() as a player's, once per fixed tick, so it plays the same at any
// frame rate; `seed` replays a match exactly (tests).
export function createLocalMatch({ mode = '2p', level = 'easy', demoLevels = ['normal', 'normal'], seed = (Math.random() * 4294967296) >>> 0, controls, renderer, events, headStart = 0, tutorial = false }) {
  const duel = createDuel({ seed, headStart });
  duel.join(0);
  duel.join(1);
  duel.startMatch();
  const cpu = mode === 'cpu' || mode === 'demo' ? createCpu({ level: mode === 'demo' ? demoLevels[1] : level, seed: (seed ^ 0x9e3779b9) >>> 0 }) : null;
  const cpu0 = mode === 'demo' ? createCpu({ level: demoLevels[0], seed: (seed ^ 0x51ed27) >>> 0 }) : null;
  let prev = [duel.player(0), duel.player(1)];
  let showHints = tutorial && mode !== 'demo';
  controls.resetUsed();
  controls.setMerged(mode === 'cpu');

  function handle(ev) {
    const now = performance.now();
    switch (ev.kind) {
      case 'hit':
        renderer.hit(ev, now);
        break;
      case 'clash':
        renderer.clash(ev, now);
        break;
      case 'save':
        renderer.save(ev.who);
        break;
      case 'round':
        events.round?.(ev);
        break;
      case 'round-start':
        if (duel.round > 1) showHints = false;
        events.roundStart?.(ev);
        break;
      case 'match':
        events.match?.({ ...ev, stats: duel.stats, scores: [...duel.scores] });
        break;
    }
  }

  return {
    duel,
    mode,
    level,
    // One fixed tick.
    update() {
      controls.step();
      const a = cpu0 ? cpu0(duel.player(0), duel.player(1), duel.world()) : controls.sample(0);
      const b = cpu ? cpu(duel.player(1), duel.player(0), duel.world()) : controls.sample(1);
      prev = [duel.player(0), duel.player(1)];
      for (const ev of duel.step([a, b])) handle(ev);
      // The demo loops forever behind the title.
      if (mode === 'demo' && duel.state === 'end') duel.rematch();
    },
    scene(alpha) {
      const fighters = [0, 1].map((slot) => {
        const a = prev[slot];
        const b = duel.player(slot);
        if (!b) return null;
        const jump = !a || a.warp !== b.warp;
        return {
          x: jump ? b.x : a.x + (b.x - a.x) * alpha,
          y: jump ? b.y : a.y + (b.y - a.y) * alpha,
          ph: b.ph,
          charge: b.ph === PH.CHARGE ? Math.min(1, b.ch / K.chargeMax) : 0,
          pw: b.pw,
          fx: b.fx,
          fy: b.fy,
          teeter: duel.offTicks(slot) > 0,
          online: true,
          me: mode === 'cpu' && slot === 0,
        };
      });
      const hints = showHints
        ? [0, 1].map((s) => (controls.used(s) || (mode === 'cpu' && s === 1) ? null : events.hintFor?.(s, mode)))
        : null;
      if (hints && hints.every((h) => !h)) showHints = false;
      return {
        fighters,
        floe: duel.floe,
        sinkAt: duel.sinkAt,
        floeKey: `${duel.roundSeed}:${duel.state === 'end'}`,
        elapsed: duel.elapsed + alpha,
        state: duel.state,
        goIn: ((duel.goTick - duel.ticks - alpha) * 1000) / 60,
        hints,
        round: duel.round,
        scores: duel.scores,
      };
    },
    get state() {
      return duel.state;
    },
    rematch() {
      duel.rematch();
      prev = [duel.player(0), duel.player(1)];
    },
    debugState: () => ({ state: duel.state, round: duel.round, scores: [...duel.scores], tick: duel.ticks, p: [duel.player(0), duel.player(1)] }),
  };
}
