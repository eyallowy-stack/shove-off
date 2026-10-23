# Shove Off                                                    v1 · 2026-10-23

```
 ●●○  CORAL                    0:24                    TEAL  ●○○
          . ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ .
       ~ ~      ⬡⬡⬡⬡⬡⬡  (cracking outer ring)   ~ ~
     ~ ~      ⬡⬡⬡⬡⬡⬡⬡⬡                         ~ ~
     ~ ~     ⬡⬡ (C)>>>>  ⬡⬡⬡ (T)  ⬡⬡            ~ ~      C = Coral, charging (glow ring)
     ~ ~      ⬡⬡⬡⬡⬡⬡⬡⬡                         ~ ~      T = Teal, teetering near an edge
       ~ ~      ⬡⬡⬡⬡⬡⬡                        ~ ~
          ' ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ '
```

**Promise.** Shove your friend off a crumbling ice floe before they shove you.
**Feeling.** 1) The yell when a charged dash sends someone flying. 2) The near-miss: a teeter on the edge, saved, then the counter-hit.
**Devices.** Solo: one player against the computer, on keys, a pad or touch, on a laptop or a phone (from the Home Screen, offline too). Local: one laptop keyboard, two players, or two gamepads, or one phone or tablet shared from opposite ends. Online: each player on their own laptop or phone. Every sound has a visual twin, so it also works muted.

## Core loop
- **Moment (seconds).** Slide around on the ice, line up a dash, then read theirs. A dash is a commitment: you can't steer while dashing, and you recover slowly afterwards, so a dash that misses can be punished.
- **Run (one round, 5 to 45 s).** The round starts on a big floe. From 10 s the outer ring of tiles cracks and then sinks every 5 s, so the space shrinks and you're forced to fight. The round ends on a ring-out: a full-charge hit from mid-floe can do it at once, and the shrinking floe settles the rest.
- **Match (2 to 4 min).** First to 3 round wins. Then the scoreboard and Rematch, one press.
- **Return.** A rivalry tally on this device (Coral 7, Teal 5), plus the match's fun stats.
- **Empty-room test.** Gliding on ice with momentum and snapping a stretched-out dash already feels good with no goal. That's the verb, so build and tune it first.

## Controls (remappable; nothing on Shift)
| | Move | Dash: tap for a quick jab, hold to charge (up to 0.7 s), release to launch |
|---|---|---|
| P1 Coral | W A S D | Space or F |
| P2 Teal | Arrow keys | / or . or Numpad 0 |
| Gamepad | Left stick | A or RT. Press A to join |
| Touch | Floating stick anywhere on the left half | DASH: the right half, with a big button and a charge ring. Two players can share a screen, one pad at each end |

Charging slows you to 45% speed and grows a glow ring that the other player can see. That glow is the tell, and reading it is the skill. **Controls line:** "Move: WASD / arrows. Hold Space or / to charge, let go to dash. Knock them off the ice."

## Win condition and rounds
- **Ring-out wins the round.** If your centre is off the tiles for more than the edge grace (110 ms), you fall. Within the grace you teeter and can still move back on.
- **A dash only lands on someone in front of it** (within about 73° of where it points). Walking into the side or back of a dash is a body push, not a launch.
- **The jab has a cost.** A tap is a jab: it recovers in 300 ms against a charged dash's 220 ms, so someone you jab is back up (220 ms stun) before you are. A jab that breaks someone's charge only nudges them (0.6 of a jab's knockback). Mashing loses to anyone who charges from outside its reach.
- **Dash hits dash (a clash).** If one charge is clearly bigger (by 25% or more), the bigger one wins and the other player takes the full knockback. If they're close, both bounce back. Its weight scales with the bigger dash: two jabs tap apart with a 40 ms stop, a light tink and no shake; the full 140 ms stop, spark, ring and sound are for two dashes at least half charged. That big one is the best moment in the game, so it's kept rare.
- **Every round ends.** Tiles sink outside-in on a fixed schedule, and by 50 s only the centre tile is left. If both players fall on the same tick, the round is replayed and nobody scores.
- **The match ends** at 3 round wins. Players swap spawn sides each round. **Comeback:** short rounds plus the best-of-5 reset momentum. An earned head start for the round loser (a half-charged first dash) sits behind `?v=comeback` to playtest.
- **Score** counts ring-outs only, so it rewards spacing and reading the other player, not mashing. Shown as round pips plus the rivalry tally.

## Onboarding (playing within 30 s)
One overlay: the promise, a looping 3-frame picture of a charge and a launch, the buttons **Play vs Computer** (first and focused) · **2 players here** · **Online** · Settings, and "or press any button on a controller". The first keypress unlocks audio. Round 1 is the tutorial: key hints float under each fighter ("WASD · Space") and fade on first use. The countdown is 3-2-1-GO. The first bonk lands within about 5 s, because the floe starts small enough to meet in the middle.

## Juice list (numbers from avoid-vibecoded-games)
- **Dash launch.** Stretch along the direction (1.3 × 0.75, recovering in 120 ms), a dust puff, a 3-frame afterimage trail and a whoosh. For the local player this all plays instantly, before the server answers.
- **Charge.** The body squashes down as the charge builds, with a fine tremble, and the glow ring grows. A ring flash and a "ping" mark full charge.
- **Hit.** Hitstop 70 ms (140 ms for a full charge or the round-winning hit; a clash scales from 40 to 140 ms with the bigger dash). The victim gets a white flash (80 ms) and squash-and-spin, and both players take knockback (the attacker gets 25% recoil). A star-burst of particles. Screen shake of 0.15 to 0.3 s that decays, sized by power. A tap jab barely shakes.
- **Edge.** A teetering fighter flails its arms and the tile edge glows. Saving yourself from the grace window counts as a "clutch save" stat.
- **Tiles.** 1.5 s before sinking, tiles wobble, crack and darken. Then they tip, shrink and sink with a ripple. The danger is always shown before it happens.
- **Ring-out.** The loser tumbles and shrinks into the water with a splash ring. After the round is decided, the last 0.4 s plays at 40% speed. This is presentation only.
- **UI.** Score pips fill with an ease, numbers punch-scale, countdown numbers punch in and out, and menu buttons press down. Fighters have eyes that track the opponent, blink and bob while idle.
- **Reduced motion** (on by default when the system asks for it; there's also an in-game toggle and a shake slider): no screen shake, no slow-mo and no afterimages, and tile warnings use a pattern and colour instead of a wobble. Hitstop stays, because it's a freeze, not movement. Never more than 3 large flashes a second, and only the fighter flashes, never the screen.

## Sound list (Web Audio, generated, 2 layers each, pitch ±5%, volume ±10%)
- **Charge:** a hum that rises with the charge, plus a bright ping at full.
- **Dash:** a noise sweep (whoosh) plus a short rising blip.
- **Bonk:** a sine thump falling from 160 to 50 Hz plus a high-passed noise crack, scaled by power.
- **Clash:** two detuned triangle waves ringing plus a thump. Two jabs bumping get a short high tink instead.
- **Tile crack:** soft rattles. **Tile sink:** a low-passed crumble.
- **Teeter:** a wobbly two-note creak.
- **Ring-out:** a falling slide whistle plus a splash (low-passed noise).
- **Countdown:** three beeps, then a higher GO.
- **Stings:** a 2-note arpeggio for a round win, a 4-note arpeggio for the match win, and a rising four-note run onto a held note when a new opponent unlocks (its visual twin is the status line on the scoreboard).
- **UI:** a tick on move, a blip on confirm, a soft back sound.
- **Online:** a chime when the opponent joins, a low tone when they drop.
- **Mix:** buses for sfx and UI, a master volume, M to mute.

## Accessibility
- Menus are real `<button>`s. They work with arrow keys, Tab, Enter and Space, and Esc goes back or pauses local play. Focus is always visible and targets are at least 44 px.
- A live region announces each round result ("Teal wins round 2, 2 to 1"), and who you're up against when a solo match starts.
- The opponent picker is a group of real buttons, each labelled with the name, difficulty, personality and record. The locked one stays focusable with `aria-disabled` and says how to unlock it; pressing it says so in a status line. Difficulty shows as pips and as a word, never colour alone.
- Fighters differ by colour and pattern (Coral has stripes and a "1" badge, Teal has dots and a "2"). Text contrast meets AA.
- Sound, shake and motion are adjustable in Settings.

## Online-sync model (multiplayer-web-games)
- **Model.** A real-time action 1v1, so one authoritative room on the server. Clients send intent (`{mx, my, dash}` with a sequence number). The server decides every hit, clash, knockback, sinking tile, ring-out and point.
- **Transport.** A WebSocket handled by the starter's built-in RFC 6455 server (`mini-ws-server`, Node built-ins `http` + `crypto` only). It runs in one Node process that serves the page and the rooms on one origin, bound to `127.0.0.1:8793`.
  - Why not SSE+POST: inputs go up 30 times a second, which would mean 30 HTTP requests a second per player. The skill keeps SSE for scoreboards and trivia.
  - The skill labels this server "tests and local development". That fits localhost and one trusted friend over Tailscale. Public hosting later needs the user's approval, a swap to `ws` (an npm install) or the Workers variant, and `security-review` first.
- **Rooms.** Rooms live at `/room/shove/<code>`, with a 4-character Crockford code (typed `k7-qo` joins `K7Q0`). Two seats; a third player gets a "Room full" close (4006).
  - Each seat has a stable id and a token. A dropped player keeps their seat for 20 s, and `pauseBelow: 2` stops the round clock while they're away (no free wins). A hidden tab counts too, after 1 s (a phone switching apps used to hand the other player a free ring-out), and a tab that reconnects while hidden says so in its hello. A match never starts around an away player. After the grace, the match ends with a message, or a CPU can take the seat.
  - The player who waited is never dropped when the clock starts again: the server resets everyone's last-seen time on resume and start, and a paused client pings at the match rate. A Rematch pressed while the room is paused counts, and the scoreboard rebuilds the button from the room's ready list.
  - The room you're in is kept on the device (code, seat, token), so an app thrown out of memory offers "Rejoin room K7Q0" on the title while the seat is held.
  - Rosters are versioned. Reconnects use backoff with jitter and stop after about 2 minutes with a clear message. Close codes 4004 and 4006 are shown as plain words.
- **Rates.**
  - The server ticks at 60 Hz, and local mode runs the same tick, so both modes feel identical.
  - Snapshots and input flushes run at 30 Hz, not the starter's 15. In a 1v1 you're aiming at the drawn opponent, and 30 Hz halves the interpolation delay to about 83 ms. A Node host doesn't bill messages. Measure 15 against 30 with the bots.
  - The interpolation delay adapts: it grows by one send interval (to at most 250 ms) when the other fighter would be held or guessed on more than 5% of frames in 2 s, and shrinks back after a few clean seconds, slewing so nothing jumps. Under 2% TCP-style loss that took the bots from 75–80% interpolated (13–18% held) to 85–92% (3–7% held), with 0 corrections.
  - Hitstop and shake never pause the tick.
- **Shared `sim.js`** (browser and server). `stepPlayer(self, input)` handles ice friction, acceleration, charge, dash, endlag, the dash buffer and hitstun.
  - The whole self state is encoded so that replays are exact. Values snap to a 1/8 grid. `atRest()` makes neutral ticks skippable, and speed snaps to zero below a threshold so rest is reachable.
  - The remote row carries `[pid, x, y, warp, phase, charge, facing]`, so the other player's glow ring shows on your screen.
- **Rules** (`rules.js`, no secrets, so local mode imports the same file).
  - Hit tests use a radius 8 units more generous than the body. A hit or clash sets hitstun and knockback on both players and bumps their `rev`, so those count as expected server changes, not corrections.
  - The victim freezes for the interpolation delay plus the hitstop, then launches. This is a sim rule, so both screens show the attacker arriving first.
  - The tile schedule is computed from the round seed and the start tick, so there are no per-tile messages. Ring-outs are judged with the edge grace.
  - Also in rules: an autopilot that brings a player who isn't sending to rest. The CPU is its own module (`js/game/cpu.js`, see Solo); the room's CPU seat is Skipper, through the same `botInput` hook.
- **Client.**
  - Your own fighter is predicted and reconciled.
  - The opponent and the sinking tiles are drawn from the snapshot buffer.
  - Confirming effects (bonk, flash, shake, hitstop, splash) play when `renderTime() >= event.tm`.
  - Only `visibilitychange` counts as "away"; window blur doesn't.
- **Reaching a friend.** The server stays on 127.0.0.1. `tailscale serve` proxies HTTPS on the tailnet to it, the user shares the machine with the friend's tailnet, and that `https://<machine>.<tailnet>.ts.net` origin is added to `ALLOWED_ORIGINS`. The README gives the exact steps, checked against Tailscale's docs at build time. Free hosting comes later, as a separate step the user approves.
- **Players' data.** An optional display name of up to 12 characters (default "Coral" or "Teal") lives in room memory only and is rendered with `textContent`. There's no chat. Logs record the room, tick and player id, never names or IPs.

## Solo (added 2026-10-23)
**Promise for one player.** Beat the floe's regulars, one at a time, and keep your record against each.

- **The opponents** (Teal; you're Coral), easiest first on the **Play vs Computer** picker:
  - **Bumper**, Practice. Never shoves back. Keeps its distance and sometimes side-steps, so you can learn the charge and the aim. Doesn't count toward the record.
  - **Slush**, Easy. "Slow to react, holds a charge too long, forgets where the edge is."
  - **Skipper**, Normal. "A fair fight. Loves a big shove, gets greedy when you're near the water."
  - **The Berg**, Hard. "Reads your glow, steps aside, punishes every miss, never leaves the middle." Locked until you beat Skipper once, or take at least 2 rounds off Skipper in 3 matches.
- **Same body, same rules.** The CPU (`js/game/cpu.js`) is a player with eyes, a reaction time and two thumbs.
  - It sees what's drawn: its own fighter, the other fighter exactly as the online wire shows it (position, phase, glow-ring charge in whole percent, facing in whole degrees), and only the tiles that are visibly cracking (the 1.5 s warning). It works out your speed from where it saw you.
  - It acts on a view one reaction time old, moves a virtual stick it rethinks every few ticks, and presses a virtual dash button with a minimum press and a minimum gap. That pad goes through `deviceInput` in `sim.js`, the same call the keyboard, pads and touch make, and then into the same `duel.step()`. It never touches a fighter's state.
  - It runs once per fixed tick on its own seeded stream, so a match replays exactly and plays the same at any frame rate.
- **Difficulty is senses and judgement, never cheating.**

| | Slush (Easy) | Skipper (Normal) | The Berg (Hard) |
|---|---|---|---|
| Reaction | 333–467 ms | 183–250 ms | 167–217 ms |
| Stick | keyboard, 8-way, rethought every 7–12 ticks | analog, every 5–8 ticks | analog, every 2–4 ticks |
| Aim error | ±0.20 rad | ±0.14 rad | ±0.07 rad |
| Misjudges distance | ±25% | ±18% | ±8% |
| Notices a cracking tile | 0.4 s before it sinks | 0.6 s before | as soon as it cracks, and keeps off the outer ring |
| How often it starts an attack | 45%, rests 0.27–0.67 s | 40%, rests 0.3–0.75 s | 60%, rests 0.17–0.5 s |
| Charges it fumbles (held too long or let go early) | 40% | 35% | 6% |
| Answers your charge | 30% of the time | 85% (clash, or hover just out of its reach) | 95% (hover just out of reach, or clash) |
| Reads a masher (2 jabs in 3 s) | never | always: charges from outside the jab, meets the next one, jabs back out of a stun | always |
| Near the water | forgets the edge, even when it lets go of a charge | careless (wants little room, sometimes misses that it's teetering), but never dashes itself off | keeps to the middle |
| Positioning | walks straight at you | walks straight at you | lines up on the centre side, circling round outside your jab |

- **Feels like a person.** It pauses before committing, feints in and out to draw a dash and punishes the recovery, goes all in when you're near the water (greed), sits on a full charge until it gets bored, and lets go a little inside its reach because it knows it misjudges. Slush also drifts off now and then. Counted over 12 matches in `tests/cpu.test.mjs`: Skipper paused 110 times, feinted 20 times and went greedy 18 times; The Berg hovered at the edge of reach 45 times.
- **Return loop.** This device's record against each CPU (wins–losses) shows on the picker and the title. Beating Skipper once unlocks The Berg, and so do 3 matches against Skipper in which you took at least 2 rounds, so a player who is learning isn't stuck behind a wall (the picker shows the count). The unlock is announced once, with a sting, and the scoreboard then offers it. After a win, the scoreboard offers the next one up ("Take on Skipper"). The one lock gives the ladder a goal without blocking anything else: 2P and online are never locked. Stored in `js/solo.js` through the guarded storage, so a private window just forgets.
- **Practice** cost one flag (`attacks: false`), so it's in. Bumper never shoves, so a round you lose there is the ice taking you, and the banner and scoreboard say "The ice got you" rather than "Bumper wins".
- **It stops attacking once you're going under.** It used to charge at your sinking body and let go over the water in most outros; now it drifts back to the middle (a charge is kept, not thrown).
- **Endlag is drawn.** The CPU punishes a fighter recovering from a dash, so recovery is visible to people too: an off-balance pose with arms flung back and skid marks behind, static so it shows under reduced motion.
- **Measured** (seeded, `tests/cpu.test.mjs`, re-measured 2026-10-23 after the polish pass below):
  - 240 CPU-vs-CPU matches across every pairing all finished; the longest round was 45.3 s.
  - Hard beat Easy 49/50 and Normal 50/50; Normal beat Easy 38/50.
  - A scripted first-time player (sees 300–450 ms late, walks at you, charges when close) beat Slush 52/60, Skipper 35/80 (44%; 45/100 and 29/80 on other seeds) and The Berg 0/50.
  - The rush (hold DASH, walk at them): a 233 ms rusher beat Skipper 47/80 (59%) and a 333 ms one 45/80 (56%); The Berg beat them 59/60 and 60/60.
  - Mashing: against Skipper a 5-a-second keyboard masher won 18/60, a 4-a-second one 10/60, a sloppy masher 3/60, jab-on-sight 26/60; against The Berg every masher, including the analog one, won 0/50. (An analog 6-a-second masher still beats Skipper about 80% on 100 seeds; it isn't in Skipper's bounds.)
  - The CPU threw itself in after winning a round 0 times in about 320 rounds; Skipper and The Berg dashed themselves off 0 times (Slush 6, on purpose).
- **The old known gap is closed.** Holding DASH and walking straight at Skipper used to beat it every time, and so did mashing the jab (40/40 against Slush and Skipper). Both are now pattern reads, not reflexes: Skipper and The Berg notice a masher (2 jabs in 3 s) and charge from outside its reach, and they keep just out of a bigger charge's reach, with extra room for their own reaction time, then let their charge go into the miss. Skipper got quicker eyes (183–250 ms) so those reads land, and was softened everywhere else (it attacks less often, fumbles more, is careless at the edge) so a first-timer still wins about a third of the time. The README tip to rush Skipper is gone.
- **Found on the way.** The first build's camper test bot reacted instantly. With a reaction delay like anyone else's, a camper in the middle beat every level. The CPU now:
  - circles round outside a jab instead of cutting through it to reach the centre side;
  - doesn't jab back at a glow that has only just lit (usually a jab on its way);
  - doesn't treat a mutual bounce as an opening.

  The balanced bot now beats the honest camper in 100% of 400 matches, and The Berg beats a camper with its own senses 25/30. Balance re-measured on the new CPU (2,000 bot matches): the left spawn won 50.7% of rounds, Coral won 49.7% of matches, and the longest round was 55.1 s (median 41 s).
- **Next playtest.** Does a real first-timer beat Skipper about a third of the time, and does mashing or rushing stop working within a match without feeling like the CPU suddenly cheated? Does losing to The Berg read as "it out-read me" rather than "it cheated"?

## Phones and tablets (added 2026-10-23)
**Promise on a phone.** The same 30 seconds of fun under two thumbs, from the Home Screen, with or without a connection.

- **Touch is one more device on the same path.** `js/touch.js` turns fingers into a stick vector and a DASH button per player and hands them to `controls.js` (`touchStick` / `touchDash`), which goes through `deviceInput` like the keys, the pads and the CPU. Nothing in the sim knows it's a touch.
  - **Stick:** the whole left half. It appears where the thumb lands, so there's no button to find. Full push at 52 px of travel, a radial dead zone of 18% scaled so a small push is a slow walk, and past 1.35 radii the centre trails the thumb, so swinging the other way turns at once.
  - **DASH:** the whole right half, with a big button (about 100 px) where the thumb rests. Tap to jab, hold to charge, let go to launch: the same edges as a key, so a tap shorter than a tick still jabs. A ring round the button fills with the charge in the glow colour of the in-world tell, and flashes at full.
  - One finger per control, tracked by pointerId: steer and charge at once; a finger that slides over keeps doing what it started; extra fingers are ignored; cancel and lost capture end a finger like a lift.
  - Shown on a touch screen (pointer: coarse) or from the first touch; a key or a pad button hides them. Settings: auto, always, never, and a left-handed swap.
  - Round 1 shows a dashed ring where the left thumb goes until you move. Tutorial hints under the fighters are for keys only. The rings sit at least 24 px in from the sides, clear of the system Back edge swipe.
  - Settings (accessibility, XAG 107): touch control size (small, medium, large: the DASH button, the thumb ring and the stick's travel), a fixed stick instead of the floating one, and **Easy charge** (tap DASH to start charging, tap again to launch) for anyone who can't hold a button. All of it goes through the same `touchDash`/`touchStick` calls; the sim doesn't change.
  - **Back** (iOS Safari's edge swipe, Android's gesture navigation, a Back button) during a match opens the pause menu: a match pushes one history entry and Back pops it.
- **Two players on one screen fits, so it's in** (it was a scope cut). The view is one shared top-down camera, the floe is radially symmetric, there's no hidden information (the glow tell is visible from both ends), and each player needs two controls. It also gives **2 players here** a meaning on a phone, where there's no keyboard.
  - Each player gets a pad at their end turned toward them: top and bottom when the device is upright, left and right ends when it's sideways. Their left half is their stick, their right half their DASH, so both get the same hands. Each pad has its own name, pips and round banner facing its player, and the 3-2-1-GO is drawn twice, once for each.
  - The stick works in screen space, unrotated: drag toward where you want to go on the screen and you go there, from either end.
  - Sound and pause sit just off the floe (below it upright, beside it sideways), so they never cover the ice.
- **App-like page.** The viewport is `width=device-width, initial-scale=1, viewport-fit=cover` (no zoom lock: zoom is stopped on the play surface only). On phones, tablets and small windows the stage is the whole screen; the HUD, the controls, the menus and the toast keep clear of the notch and the home bar. During a match, and only then: `touch-action: none`, no text selection, no callout, `overscroll-behavior: none`, and Safari's gesture events are cancelled. Every menu button is at least 44 by 44 px, checked at 375 px wide.
- **The floe fits any shape.** The canvas fills the stage; a world box of 660 by 600 units (the floe plus room to fly off it) is fitted into what the HUD and the thumbs leave free. Upright on a phone the floe sits above the thumbs; sideways the thumbs sit either side of it. On the 16:9 laptop stage it comes out at the original 1.1 px per unit. The floe glides to its new spot when the controls appear (snaps under reduced motion). World text has a 12 px floor so the tags stay readable on a phone.
- **Performance.** Pixel ratio capped at 2, drawing capped at 60 fps on touch screens by a whole-number divisor of the measured display rate (60 and 90 Hz draw every frame, 120 Hz every second, 144 Hz every second for 72; the old time threshold drew a 90 Hz phone at 45), the sim a fixed 60 Hz either way. The title's demo match draws at half rate behind a menu, and the title strip isn't drawn where it's hidden; and no layout in the frame loop: sizes are measured in ResizeObserver callbacks, the stick moves by `transform`, the charge ring by its stroke offset, the HUD writes only on change, and the round banner punches in with WAAPI instead of a forced reflow.
- **Sound.** Web Audio starts on the first tap and resumes on return from the background (pageshow, focus, visibility); if iOS refuses, the next tap anywhere brings it back. The silent switch can't be read, so a visible Sound toggle is on the title, the pause menu and the play screen. Settings › Play over my music (iPhone) uses the "ambient" audio session, so the player's music keeps playing. Leaving the page pauses local play with Resume focused.
- **Haptics** with `navigator.vibrate` where it exists (Android): a hit sized by power, a clash, full charge and a ring-out. Nothing on iPhone. A setting, never the only feedback.
- **Installable and offline.** A manifest, generated icons (`tools/make-icons.mjs`, drawn from shapes), the Apple Home Screen tags, and `sw.js`. It caches every file the game loads, all at once, under a version that's a hash of those files, stamped by the room server when it serves `sw.js`. After one visit Play vs Computer and 2 players here work offline; online rooms always go to the network, and the worker never answers or caches the room endpoints. A new version waits until the player presses Reload on a toast in the menus. Off at localhost unless `?sw`.
- **Online from a phone** is the laptop's netcode. What's new: when the page comes back, the network changes, or the browser says it's online again, `net.js` probes. A dead socket that still says OPEN (iPhones do this after sleep) is dropped after 1.5–2.5 s of silence and the same seat is rejoined, instead of waiting for the 4 s match or 45 s lobby staleness check; a long backoff is skipped once the network is back.
- **Measured.** `tests/touch.test.mjs` (16): vectors, dead zone, follow, two fingers, tap vs hold into the sim, cancels, resizes, swap, both shared layouts. `tests/wake.test.mjs` (3): rejoined in about 1.7 s after a silent drop, lobby and mid-match. `tests/pwa.test.mjs` (9). Checked in a browser at 375 by 812 and 812 by 375: title, a CPU match with the stick and the charge ring, both shared-screen layouts, the results screen, an online room against the room's CPU, every menu target, offline after one visit with the server stopped, and the update toast.
- **The floe on a phone held upright** is about 0.55 px per world unit at 375 wide: the floe is already as wide as the screen, and drawing it bigger would crop the outer ring you get knocked off. Instead the glow ring keeps a minimum thickness in screen pixels (2.5 px rising to 6.5 px at full charge) and starts brighter, and the 3-2-1-GO is drawn above the fighters instead of over them.
- **Android** shows a plain serif font: none of the slab fonts in the stack ship there, and bundling one would mean downloading a font file. Left as it is.
- **Not checked here:** a real iPhone (the silent switch, sound after locking, Safari's own gestures, real frame rates) and Tailscale on the phone. Next playtest: does the right-half DASH zone cause accidental dashes, and is 52 px of stick travel right for small hands?

## Scope cuts (out of scope; new ideas land here first)
- More than 2 players
- Power-ups or items
- More than one arena
- Characters with different stats or skins. (Solo's one unlock, The Berg, is an opponent, not a character.)
- Music
- Replays
- A room browser or matchmaking
- Spectator or display seats
- Free-text chat (never)
- Accounts and online leaderboards
- Rollback netcode (only if the bots show server authority feels wrong)
- A key-remap UI beyond the settings list
- Public hosting (later, approved by the user)

## MVP slice
1. The verb on one floe: move, charge, dash, hit and ring-out, with hitstop, shake and the first 4 sounds.
2. Rounds, the sinking schedule, the match and the scoreboard, plus Rematch. Local 2P and the CPU.
3. The online room on the same rules. Then touch, settings and the full sound list.

## Handoff
- **TUNING** (start value, range to try):
  - Movement: `tickHz 60`, `accel 1400 (1000–2000)`, `maxSpeed 260 (200–320)`, `iceDamp 3.0/s (2–5)`.
  - Charge and dash: `chargeMaxMs 700 (500–900)`, `chargeSlow 0.45 (0.3–0.6)`, `dashSpeed 520→900`, `dashMs 160 (120–220)`, `endlagMs 220 (150–300)`, `dashBufferMs 120 (80–150)`.
  - Hits: `knockback 380→950` (was 820), `recoil 0.25`, `hitTolerance 8`, `clashMargin 0.25`, `hitFacing 0.3`, `jabOnCharge 0.6`, `endlagJabMs 300` (a charged dash's is 220).
  - Arena: `edgeGraceMs 110 (80–150)`, `crumbleStartS 10 (10–20)` (was 15), `crumbleEveryS 5 (3–7)`, `warnMs 1500`.
  - Match and feel: `roundsToWin 3`, `hitstopMs 70/140`, `loserHeadStart 0 (0–0.5)`.
  - Network: `snapshotHz 30 (15–30)`, `inputHz 30`, `graceMs 20000`, interpolation delay 83–250 ms (adaptive), hidden-tab pause after 1 s, protocol 4.
- **Tests** (`node:test`):
  - The same inputs give the same state (determinism), and a neutral step at rest is a no-op.
  - A dash released during endlag fires within the buffer. A player inside the edge grace can walk back on.
  - Over 2,000 bot matches: every round ends by 60 s, and each spawn side wins 45–55%.
  - A centre-camper bot and a max-charge-spam bot each lose to the balanced bot.
  - A double ring-out replays the round.
  - Online, with the starter's bots and the lag shim: 0 prediction corrections (apart from server changes), the interpolation share reported, rejoin to the same seat, and back-to-back matches still at 0 corrections.
- **Next playtest.** Does a charged dash get punished often enough that tap jabs and spacing matter, or is it charge-and-pray? A friend's first ten seconds: do they find charging without being told? `?debug` shows the TUNING panel and the net overlay. `?v=comeback` turns on the loser's head start.
- **Your call.** The theme (wrestlers on ice, coral against teal, with flat print-style ink outlines), the name, and P2's dash key.

## Concepts considered
1. **Shove Off (picked).** A sumo knockout brawler.
2. **Junk Drop.** A versus falling-block race where clears send junk to your friend. It handles lag perfectly, but it isn't fun in 30 s unless both players already know the genre, the skill gap between friends makes matches one-sided, and there are more rules to build.
3. **Header Ball.** A side-view physics soccer game with jumping heads. It's instantly fun on one keyboard, but online the shared fast ball is drawn about 80 ms in the past while your head is predicted in the present, so kicks that look clean miss. Fixing that needs rollback. It also overlaps the arcade's Air Hockey and Tray Pong.

**Why Shove Off:**
- It has the most juice per line: hitstop, shake, squash and splash all come from one verb.
- It's two buttons per player, so it's easy on one keyboard.
- Rounds always end, because the floe sinks.
- Its only contact is a discrete dash hit, and the server judges that with a generous radius. That's the lag-tolerant shape the skill recommends.
- It's the smallest scope of the three.

## Build notes (2026-10-23)
What was measured on the first build, and where it differs from the plan above.

- **Balance (2,000 CPU matches, `tests/balance.test.mjs`).** Every round ended by 55.4 s. The left spawn won 50.2% of rounds and Coral won 48.8% of matches. The balanced CPU beat the centre-camper and the max-charge spammer in 100% of 400 matches each. CPU-vs-CPU rounds run long (median 45 s), because CPUs clash a lot near the end. Human rounds will tell us more.
- **Tuning changes.** `radius` went to 26 so the wrestlers read at laptop size; balance held. The stun was shortened (220–320 ms at ice friction) so a full-charge hit from the centre leaves you near the edge rather than in the water. Before that, charge-spam won 99.5% of matches.
- **The CPU's counter-play** to a charge is a jab while it's below 60%, or charging back to force a clash. Near the edge it charges back in, because a charged dash beats a jab in a clash. (Superseded by the Solo section: that CPU is now the `bot` profile in `js/game/cpu.js`.)
- **Netcode change.** Online clients send a tick every frame during a match, even standing still. `atRest()` still makes those ticks no-ops (tested). Without them, a standing player who got hit stayed frozen 7 ticks (117 ms) too long on the server, and so on the other screen, because the server only steps a fighter when its inputs arrive. With them, it's within 2 ticks (`tests/online.test.mjs`).
- **Room fix (server/room.js, from the starter).** Inputs now carry an epoch that the room bumps on every start, pause and resume, and stale inputs are dropped. The bug: a pause shorter than one round trip, such as a quick drop and rejoin, let inputs sent before the pause land after the resume. The player who stayed then got prediction corrections (8 in a test, and a 52-unit snap). That test now passes with 0, and the protocol version went to 3.
- **15 vs 30 snapshots (`tools/rate-sweep.mjs`).** 30 Hz: 99.4% interpolated on clean links (15 Hz: 98.4–98.7%) at half the delay (83 ms vs 167 ms). Under 2% TCP-style loss, 30 Hz drops to 79.7% (13.9% held still), and 15 Hz holds 93.4%. We kept 30 Hz. If a friend's link is lossy, switch both rates to 15.
- **Slow-mo on a ring-out** is presentation only: the fall, particles and camera punch run at 40% for about 0.9 s. Positions run at normal speed.
- **`?v=comeback`** is local play only.
- **Not tested on real hardware:** gamepads, touch on a real phone, Safari, and Tailscale itself.

## Polish pass (2026-10-23)
A review found that mashing beat the computer, that Skipper was a wall with two tricks past it, that clashes shook the screen nonstop, and several online and phone problems. What changed and what was measured (seeded scripts in `tests/harness.mjs`; the "before" numbers are the review's):

- **Mashing.** A 5-a-second keyboard masher beat Slush and Skipper 40/40. Now the jab costs more recovery than a charged dash (300 against 220 ms), a jab only nudges a charger, and Skipper and The Berg read a masher and answer it. Against Skipper the masher wins 18/60; against The Berg every masher wins 0/50. Slush still loses to mashing: it's the first rung.
- **The ladder.** The first-timer script against Skipper went from 5/40 to 35/80 (44%). The rush went from 40/40 to 47/80 (59%) and 45/80. The Berg against the quick rusher went from 27/50 to 59/60. The Berg also opens after 3 close losses to Skipper.
- **Clashes.** Two jabs bumping used to get the biggest effects in the game (a 140 ms stop and a 14-unit shake). Now hitstop runs from 40 to 140 ms with the bigger dash, shake is 0 for jab on jab and scales up to 14, and the big spark and ring need two half-charged dashes. Two jabs push each other fully apart so they don't stick together. Between two mashers clashes are still frequent (about 40 a round for two sloppy keyboard mashers), but each one is now a light tap.
- **Rounds and ring-outs.** Between two equal first-timers, 231 of 234 ring-outs went through sunk ice and rounds took 40 s. Each of these was tried on its own (novice against novice, and rusher against novice): `crumbleStartS 10`, 4 rings, `knockMax 950` with `stunDamp 2.5`, `knockMax 950` alone, `stunDamp 2.5` alone, and a longer stun. None of them made the first-timer script ring anyone out early, because 83% of its hits are jabs in the middle (the median victim is 36 units from the centre). Kept: `crumbleStartS 10` (first-timer rounds went from 40 to 34 s, matches from 2.7 to 2.6 min) and `knockMax 950`. With that, a full-charge hit from mid-floe now rings someone out: the balanced bot's rounds went from 41 s to 8 s, with 100 of 170 ring-outs before the ice sank, against 0 before. So between people who charge, hits decide rounds; between people who only jab, the floe still does. The 2,000-match balance test holds (left spawn 49.4% of rounds, Coral 50.7% of matches), and the new balance tests on first-timer and rusher pairs give 51.4% and 50.4% for the left spawn.
- **Facing.** 7% of first-timer dash hits used to come from a dash pointed more than 90° away from the victim. Now a dash must point within about 73° of them, and the measured share of off-angle hits is 0%.
- **The CPU after a won round.** It threw itself in after you in 73 to 104 of 120 outros. Now it's 0 in about 320 rounds.
- **Online.** These were all broken: the player who waited was kicked when a 10–15 s pause ended; a Rematch pressed during a pause was lost; a hidden tab that reconnected froze on the server; a hidden tab gave the other player a free ring-out; a match could start around an away opponent; and lossy links froze the other fighter on 13–18% of frames. All are fixed, each with a test in `tests/online.test.mjs`. The Online screen no longer tells a friend to open `http://localhost`, the lobby counts only online players, a 4010 has a Reload button that fetches the new version, and `session.frame()` gets the real frame time.
- **Phones.** Join no longer falls off the Online screen (0 px overflow at 320 and 375), the scoreboard fits a phone held sideways (Rematch at y 157 of 375), and Settings fits 320 px. A 90 Hz phone draws 90 fps. Back opens the pause menu, the screen stays on in the lobby and in online matches, and an app installed from localhost keeps its offline copy. Teal has Enter as a second dash key, and there are touch size, fixed stick, easy charge and play-over-music settings.
- **Not done here:** a real phone, Safari, Tailscale itself, and a playtest with people. Next playtest: can Teal charge and steer comfortably with Enter on a laptop, and does a first-timer feel Skipper is fair?
