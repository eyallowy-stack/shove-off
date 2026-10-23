# Shove Off

Shove your friend off a crumbling ice floe before they shove you.

A 1v1 sumo brawler: you against the computer, or two players, on a laptop or a phone. Slide around on the ice, tap to jab, hold to charge a big dash that the other player can see coming, and knock them into the water. From 10 seconds the outer tiles crack and sink every 5 seconds, so every round ends. First to 3 ring-outs wins, then there's a scoreboard, a rivalry tally on this computer, and a one-press Rematch.

It's plain HTML, CSS and JavaScript modules: no build step, no engine, no npm packages. The room server uses only Node's built-in modules. The design is in [DESIGN.md](DESIGN.md).

## Play right now, on this computer

```bash
cd ~/Projects/duel-arena
~/.local/bin/node server/server.mjs
```

Then open **http://localhost:8793** and press **Play vs Computer** (or **2 players here** with a friend on the same keyboard). Ctrl+C in the terminal stops the server.

The page needs a server even for local play, because browsers won't load JavaScript modules from a double-clicked `file://` page. This one server also runs the online rooms. It listens on 127.0.0.1 only, so nobody else on the school network can reach it.

(For local play only, `python3 -m http.server 8793 --bind 127.0.0.1` from this folder works too. Online won't work with it.)

### Controls

| | Move | Dash: tap to jab, hold to charge (up to 0.7 s), let go to launch |
|---|---|---|
| Coral (player 1) | W A S D | Space or F |
| Teal (player 2) | Arrow keys | / or Enter (or . or Numpad 0) |
| Gamepad | Left stick or d-pad | A or RT. Press A to join |
| Touch (phones and tablets) | Drag anywhere on the left half | DASH: tap to jab, hold to charge. Two players can share one screen, one at each end ([Play on your phone](#play-on-your-phone)) |

**M** mutes, **Esc** (or **P**) pauses local play. You can change every key in **Settings**. Shift is never used, because it triggers Sticky Keys on Windows.

**How to win.** Charging slows you down and shows a glowing ring with a wedge pointing where you'll go. That's the tell. A charged dash is strong, but it's a commitment: you can't steer it and you recover slowly (you're drawn off balance, with skid marks, while you do), so a miss gets punished. A full-charge hit from the middle of the floe can knock someone straight into the water.

A quick jab breaks a charge that isn't ready yet, but only nudges the charger, and a jab takes longer to recover from than a charged dash. So mashing jab gets you punished: someone you jab is back on their feet before you are, and a charge of about a third or more beats a jab head on. A dash only hits someone in front of it, so walking into the side or back of a dash is just a bump. When two dashes meet head on, the one that's 25% stronger wins, otherwise both bounce (two jabs just tap off each other; two big dashes make the big spark). If you slide off the edge you have about a tenth of a second to scramble back (a "clutch save").

A demo match between two CPUs runs behind the title screen.

### Playing alone

**Play vs Computer** is the first button. Pick an opponent (you're Coral, they're Teal):

| | Who | What they're like |
|---|---|---|
| Practice | **Bumper** | Never shoves back. Keeps its distance and sometimes side-steps, so you can learn the charge and the aim. Doesn't count toward your record. |
| Easy | **Slush** | Slow to react, plays like someone on a keyboard, holds a charge too long, forgets where the edge is. A first-timer can beat it. |
| Normal | **Skipper** | A fair fight. Quick eyes, so mashing or rushing it won't work for long, but it attacks less often, misjudges more and gets careless near the water. A first-timer wins about a third of the time. |
| Hard | **The Berg** | Fast. Reads your glow and steps aside or hovers just out of reach, punishes every miss, and keeps to the middle as the ice sinks. Locked until you beat Skipper once, or take 2 rounds off Skipper in 3 matches. |

The computer plays by exactly the same rules and physics as you: it presses a virtual stick and dash button that go through the same input code as your keys, and it only knows what's on screen (it sees you a reaction time late, and only knows a tile is sinking once it visibly cracks). Harder ones react faster, aim and judge distance better, and read the floe sooner. Skipper and The Berg also learn your habits within a match: keep mashing jab and they start charging from outside your reach and meeting your jab with it; keep rushing in with a held charge and they keep just out of its reach and punish the miss.

This computer remembers your record against each one (wins–losses, on the picker and the title screen). After a win, the scoreboard offers the next one up. Tip: if Skipper keeps beating you, keep your distance while it charges, let its dash miss, and hit it while it's off balance. Against Bumper (Practice) you can't lose a round to Bumper itself, only to the ice, and the scoreboard says so.

## Online rooms

1. Start the server, as above.
2. Open the game and choose **Online**, then **Make a room**. You get a 4-character code like `K7Q0`.
3. The other player opens the same address, chooses **Online**, types the code and presses **Join**. Typing `k7-qo` works too: O counts as 0, and I and L count as 1.
4. The match starts as soon as both of you are in. No friend yet? **Play the CPU** fills the seat with Skipper (Normal).

The Online screen and the lobby tell you what address your friend needs. On `localhost` they say that this address only works on your computer, because to anyone else `localhost` is their own device: your friend needs your `https://…ts.net` link from [Playing with a friend over Tailscale](#playing-with-a-friend-over-tailscale).

To try it alone, open two browser **windows** side by side (two windows, not two tabs, because a background tab is slowed down). Each window gets its own seat.

What happens when things go wrong:

- **A dropped connection** keeps your seat for 20 seconds, and the round clock pauses until you're back. After that, the match ends with a message. The player who waited stays connected, even through a long wait.
- **Switching to another app or tab** (or a notification on a phone) pauses the match for both of you after about a second, so nobody gets a free ring-out, and it carries on when you come back. If your connection blips while you're away, you're still counted as away until you come back.
- **If the phone throws the game out of memory** (iPhones do this to Home Screen apps in the background), the title screen offers **Rejoin room K7Q0** for as long as your seat is held, and puts you back in the same seat. A plain reload offers it too.
- **Rematch** works even if your friend's screen went to sleep on the scoreboard: your press counts, and the match starts once they're back and press it too. The button always shows who has pressed.
- **"The game was updated"** means this copy is older than the server's. Its **Reload** button fetches the new version first, so you don't get the old one again from the offline copy.
- **"That room is full"** means it already has two players. **"No room with that code"** means it was never made, or everyone left.
- Reconnecting retries with growing gaps, then stops after about 2 minutes and says so, with a **Try again** button.
- **A phone that slept, or switched from Wi-Fi to cellular,** checks its connection the moment it's back. If the old connection died quietly (iPhones can leave a dead one looking open), it rejoins the same seat within about 2 seconds instead of waiting to notice.

The server owns the truth. Your browser sends only what you pressed. The server runs the same `js/game/sim.js` step and `js/game/rules.js` rules as local play, and decides every hit, clash, sinking tile, ring-out and point. Your own fighter is predicted, so the controls answer instantly. Your browser sends a tick even while you stand still, because the server only moves a fighter when its inputs arrive: otherwise a standing player who got hit would hang frozen on the other screen (measured: 117 ms too long at 40 ms latency). The other fighter is drawn about 83 ms in the past from 30 snapshots a second. On a lossy link (school Wi-Fi, or Tailscale relaying your traffic) that delay grows by itself, up to 250 ms, whenever the other fighter would otherwise freeze, and shrinks back when the link is clean. Bonks, flashes, shake and splashes play at the moment the hit is visible on your screen. While you're waiting in the lobby or playing, the game asks the phone to keep its screen on (on the https address).

## Playing with a friend over Tailscale

The server stays on 127.0.0.1. [Tailscale](https://tailscale.com) gives your laptop a private HTTPS address that only your tailnet can reach. You then share just this machine with your friend's tailnet.

These steps were checked against Tailscale's docs on 2026-10-23: [Serve](https://tailscale.com/kb/1312/serve), [the `tailscale serve` command](https://tailscale.com/kb/1242/tailscale-serve) and [Sharing](https://tailscale.com/kb/1084/sharing). If it's a school-managed laptop, check you're allowed to install Tailscale on it first.

1. **Install Tailscale** on your laptop and sign in. Your friend installs it on their own device with **their own** account.
2. **Turn on HTTPS certificates** for your tailnet in the admin console, under DNS. Serve needs them. If they're off, the `tailscale serve` command walks you through turning them on. MagicDNS needs to be on too, because a shared machine is reached by its full name.
3. **Find your machine's name.** Run `tailscale status`, or check the Machines page. The address looks like `https://my-laptop.tail1234.ts.net`.
4. **Start the game server with that address allowed.** The server refuses sockets from pages it doesn't know:

   ```bash
   ALLOWED_ORIGINS=https://my-laptop.tail1234.ts.net ~/.local/bin/node server/server.mjs
   ```

5. **Serve it on your tailnet** from another terminal:

   ```bash
   tailscale serve --bg http://127.0.0.1:8793
   tailscale serve status      # shows the https address
   ```

   (Write `127.0.0.1`, not `localhost`: the server listens on 127.0.0.1 only, and `localhost` can mean the IPv6 address on some machines, which would give your friend an error.)

   It prints "Available within your tailnet". That means your tailnet only, not the public internet. Never use `tailscale funnel` for this: Funnel would put the game on the open internet.
6. **Share the machine with your friend.** In the admin console, go to **Machines**, find your laptop, open its menu, then **Share…**. Share by email or copy an invite link (treat a link like a password). Your friend accepts it in their own Tailscale account.
7. **Your friend opens** `https://my-laptop.tail1234.ts.net` (the full name: the short name won't work from their tailnet), chooses **Online**, and types your room code.
8. **When you're done:** `tailscale serve reset` turns Serve off, and Ctrl+C stops the server. You can remove your friend from the machine's Share dialog. To play again later, they need a new invite.

Notes:

- The page is already set up for this: its Content-Security-Policy allows sockets to `wss://*.ts.net`, and the client uses `wss://` whenever the page is on HTTPS.
- Tailscale's docs don't say whether Serve passes WebSockets through, or whether Serve works for a friend you've shared the machine with. I couldn't test either without your tailnet. If your friend sees the menu but stays on "Connecting…", look at the server's terminal. A line with `"ev":"upgrade-refused","why":"origin"` means the address in `ALLOWED_ORIGINS` doesn't exactly match what's in their address bar.
- Access rules (ACLs) on both tailnets apply. The default policy allows this. If your tailnet has custom rules, it needs to let your friend reach this machine.

## Play on your phone

It works on an iPhone or Android phone and on tablets, held either way up, against the computer, with a friend on the same screen, or online. On a phone it fills the screen like an app, and once it's on your Home Screen, **Play vs Computer works with no connection at all**.

### Put it on your iPhone's Home Screen

Your iPhone reaches the laptop through Tailscale, the same way a friend does, except it's your own device, so there's nothing to share.

1. On the laptop, start the server and Tailscale Serve, as in steps 1 to 5 of [Playing with a friend over Tailscale](#playing-with-a-friend-over-tailscale) (`ALLOWED_ORIGINS=https://my-laptop.tail1234.ts.net ~/.local/bin/node server/server.mjs`, then `tailscale serve --bg http://127.0.0.1:8793`).
2. On the iPhone, install the **Tailscale** app from the App Store and sign in with **the same account** as the laptop. Turn it on.
3. Open **Safari** and go to your laptop's address, like `https://my-laptop.tail1234.ts.net`. It has to be Safari: Add to Home Screen lives in Safari's Share menu.
4. Tap **Share** (the square with the arrow), scroll down, tap **Add to Home Screen**, then **Add**. A Shove Off icon appears on your Home Screen.
5. **Open it once from the new icon while Tailscale is still on.** The Home Screen copy can keep its own storage, separate from Safari's, so this first launch is what saves the game for offline (and your record against the computer may start fresh there).

After that:

- **Play vs Computer and 2 players here work offline**: Tailscale off, no Wi-Fi, airplane mode. The game is saved on the phone.
- **Online needs a connection**: Tailscale on, and the laptop's server running. With no connection, the Online screen says so.
- **Install it from the ts.net address**, not from `localhost` on the laptop: the phone needs HTTPS for the offline copy and for keeping the screen on.
- **Updates arrive by themselves.** When you change the game and restart the server, the next time the app opens with a connection it downloads the new version in the background, and the menus show **A new version of Shove Off is ready** with a **Reload** button. It never swaps files in the middle of a match.

On Android, open the same address in Chrome (with the Tailscale app on), then **⋮ › Add to Home screen** or **Install app**.

### Touch controls

| | Left thumb | Right thumb |
|---|---|---|
| Move | Put your thumb down **anywhere on the left half** and drag. The stick appears where your thumb lands, and follows it if you drag far, so turning around is instant. | |
| Dash | | **DASH**: tap for a quick jab. Hold to charge: the ring around the button fills (the same glow everyone sees around your fighter), flashes at full, and you launch when you let go. Anywhere on the right half works, not just the button. |

- Both thumbs work at once. The sound and pause buttons sit top right, out of the way.
- In round 1 a dashed ring shows where to put your thumb until you move. It sits a little in from the edge, because a swipe from the very edge is the phone's Back gesture.
- **Back** (the edge swipe on iPhone and Android, or the Back button) during a match opens the pause menu instead of leaving the game.
- The controls show up as soon as you touch the screen and hide again if you press a key or a controller button, so an iPad with a keyboard just works. In **Settings**:
  - **Touch controls** forces them on or off, and **Left-handed** swaps the stick and DASH.
  - **Touch control size**: small, medium or large (the DASH button, the stick and how far you push it).
  - **Stick**: floating (appears where your thumb lands) or fixed (always in the same spot, shown by the dashed ring).
  - **Easy charge**: tap DASH to start charging and tap again to launch, for anyone who finds holding the button hard.
- On Android phones the game buzzes on hits, full charges and ring-outs (Settings › Vibrate on hits). iPhones don't let web pages vibrate, so there it's sound and picture only, which is how the game is designed anyway.

### Two players on one phone or tablet

Choose **2 players here** and lay the device flat between you. Each of you gets your own stick and DASH button at your end, turned to face you, with your name and score.

- Held **upright**, Coral plays from the bottom edge and Teal from the top.
- Held **sideways**, Coral plays from the left end and Teal from the right.

On a phone it's cosy but it works. A tablet is roomier. Each of you drags in the direction you want to go on the screen, so it feels the same from either end.

### Sound on an iPhone

- Sound starts with your first tap (iPhones only allow sound after a tap).
- A web page can't tell where the ring/silent switch is, and while sound is on the game plays even with the switch on. The game's own **Sound** button (top right while playing, and on the title and pause menus) is the way to turn it off. Sound on also pauses music from another app, unless you tick **Settings › Play over my music**: then the game's sound mixes with your music (and follows the silent switch).
- Locking the phone, a call, or switching apps pauses a match against the computer or a friend on the same screen, and **Resume** is waiting when you come back. Sound comes back with your next tap. An online 1v1 pauses for both of you after about a second.
- On Android the title and buttons use a plain serif font, because the slab font the game asks for (Rockwell, Roboto Slab) doesn't come with Android. Bundling a font file would mean downloading one, so that's left as it is.

## Free hosting (later, and only when you decide)

Nothing here is hosted, and nothing gets uploaded unless you choose to. Hosting the room server publicly is a separate step, and it changes several things:

- **The socket server.** `server/ws.mjs` is a small built-in WebSocket server, fine for you and one trusted friend. A public server should use the `ws` package (an npm install) or a Cloudflare Workers + Durable Objects version. The `multiplayer-web-games` starter has both.
- **A security review** comes first: rate limits, origins, message sizes and abuse.
- **Players' data.** Display names would go to a hosting company and on to other players, and the host would see players' IP addresses. Most players are minors, so check each host's minimum age and get a parent's help to sign up.

Options, as of 2026-10-23 (re-check before you rely on them; free tiers change often):

- **Cloudflare Workers with Durable Objects (Free plan):** no sleep and no cold start, one object per room, and the page and rooms can share one address. The limit is a hard daily quota (100,000 requests a day, reset at 00:00 UTC; incoming socket messages count at 20 to 1).
- **Render free web service:** plain Node, one process holding every room. It sleeps after 15 minutes idle and takes about a minute to wake. Rooms are lost on every restart, and outbound bandwidth is 5 GB a month.
- **The page itself** (without online play) can go on any static host, such as GitHub Pages, because it's just files. Run `~/.local/bin/node tools/stamp-sw.mjs` first, so phones that installed it get updates (the room server does this by itself).
- **Not these:** Fly.io has no free tier for new accounts. Glitch project hosting ended. PartyKit's hosted platform shut down on 2026-10-23.

## Tests

```bash
~/.local/bin/node --test --test-timeout=300000 'tests/*.test.mjs'   # everything, about 3 minutes
~/.local/bin/node --test tests/sim.test.mjs tests/rules.test.mjs tests/project.test.mjs tests/touch.test.mjs tests/pwa.test.mjs   # quick, about a second
```

- `tests/sim.test.mjs`: the shared step. The same inputs give the same state, and a neutral step at rest is a no-op. Also the ice, the jab and charge, the committed dash, the dash buffer, the countdown, input validation and the sinking schedule.
- `tests/rules.test.mjs`: hits and hitstop, the online victim freeze, clashes (and how heavy they are: two jabs bump lightly, two big dashes stop the world), a dash only hitting someone in front of it, the jab's longer recovery and its nudge on a charge, body pushes, the edge grace and clutch saves, double ring-out replays, spawn swaps, the match and rematch, the autopilot, valid bot inputs, and the room adapter.
- `tests/balance.test.mjs`: 2,000 bot-vs-bot matches. Every round ends by 60 s and each spawn side wins 45–55% of rounds. A centre-camper bot and a max-charge-spam bot each lose to the balanced bot. Spawn sides are also checked between human-like scripted players (first-timers, and players who rush).
- `tests/cpu.test.mjs`: the computer opponents. 240 CPU-vs-CPU matches across every pairing all finish, with no round past the floe's 60 s. Hard beats Easy in most of 50 seeded matches, and each level beats the one below. A scripted first-time player beats Easy at least half the time, Skipper a fair share (22–52%), and Hard almost never. The "hold DASH and walk at them" rush wins at most about 60% against Skipper and The Berg beats it at least 75%. Five mashing scripts (5 and 4 taps a second on keys, an analog stick, sloppy uneven mashing, jab-on-sight) can't beat Skipper more than half the time (70% for the sloppy and jab-on-sight ones), or The Berg more than 10–20%. The CPU never throws itself in after winning a round, and Skipper and The Berg don't dash themselves off. The CPU's input is only what a player can press (stick, one button, a press at most every few ticks). It never reads what a player can't see (scrambling hidden state, or the future of uncracked tiles, changes nothing it does). A whole match plays tick for tick the same at 30, 60 and 144 fps and with uneven frames. It hesitates, feints, gets greedy and fumbles. The solo record and the Hard unlock (including the 3-close-matches way in) survive a reload and junk storage.
- `tests/online.test.mjs`: real sockets, the real server and the real client code, with headless bots through a simulated bad network. Two whole matches back to back at 120 ms round trip with 2% packet loss (with the growing delay, the other fighter is interpolated on about 85–90% of frames and held still on 3–7%). Also rejoin to the same seat with the clock paused, the player who waited 12 s not being dropped on resume, a Rematch pressed while paused, quick drops that pause the room for less than a round trip, a hit on a player standing still, a hidden tab pausing the 1v1 (and staying away through a background reconnect), a match not starting around an away player, room full, room gone, and the Origin check. These rooms use a faster-sinking floe so a match takes about 30 s. A friend leaving is covered from the host page's side, with the page's own start logic (`createAutoStart` in `js/online.js`): pressing Leave room mid-match or on the scoreboard, and a closed tab whose 20 s seat hold runs out (on a room that holds seats for 1.5 s) all land the player who stayed in a lobby for one that says "Your friend left the room", with no match started for one; the friend rejoining with the same code plays on; a guest whose host left becomes host and can play the CPU; and the server refuses to start a match for one.
- `tests/loop.test.mjs`: the draw cap on phones: 60 and 90 Hz screens draw every frame, 120 Hz draws 60 and 144 Hz draws 72, and the simulation stays at 60 steps a second.
- `tests/touch.test.mjs`: the touch controls with simulated pointer events, through the real input path into the shared step. Stick vectors and the dead zone (a resting, wobbling thumb does nothing; a full push is exactly 1; the direction is exact), the stick following the thumb, two fingers at once (and a third ignored), a tap shorter than a tick still jabbing, a hold charging to a full-power launch, a half hold giving half power, cancelled pointers never sticking, a resize keeping a held charge, the left-handed swap, both shared-screen layouts with four thumbs down at once, and the size, fixed-stick and easy-charge settings.
- `tests/wake.test.mjs`: a phone that sleeps or changes network. Its socket dies silently and still says OPEN; on waking it notices within the probe and rejoins the same seat in about 1.7 s, in the lobby and mid-match, and skips a 20 s backoff the moment the network is back.
- `tests/pwa.test.mjs`: the viewport and Home Screen tags, the manifest and the generated icons at their real sizes, and the service worker in a sandbox: it caches every module the page imports, opens and plays with the network gone, never answers or caches the room endpoints, replaces old versions only when the page asks, and versions itself from the files. The real server stamps that version and keeps its own files private.
- `tests/project.test.mjs`: modules import in Node, imports match file names exactly, no root-absolute URLs, the browser never imports server code, the server binds to 127.0.0.1, and there are no dependencies.

**Bots against the real server** (the shipped rules and schedule). Start the server, then:

```bash
~/.local/bin/node tools/bot-match.mjs --matches 2 --drop     # 2 matches, a mid-match drop and rejoin
~/.local/bin/node tools/bot-match.mjs --latency 60 --jitter 20 --loss 0.02
~/.local/bin/node tools/bot-match.mjs --join K7Q0            # one bot joins the room you made in the browser
```

At the end, bot B presses Leave room on the scoreboard and bot A, running the host page's start logic, must land in a lobby for one, told why, with no match started. It passes when both bots have zero prediction corrections and the other fighter is interpolated on at least 90% of frames on a clean link (80% with loss) and held still on under 5% (10% with loss). Measured 2026-10-23 after the fixes: 2 matches with a drop and rejoin, 99.6% interpolated, 0 corrections, same seat on rejoin; with 60 ms, 20 ms jitter and 2% loss, 87.6% and 91.6% interpolated, 3–6% held, 0 corrections. Re-run later that day after the friend-leaves fix (`--matches 2 --drop --latency 60 --jitter 20 --loss 0.02`): 89.2% and 89.0% interpolated, 4.5% and 4.4% held, 0 corrections, same seat on rejoin, and the leave check passed.

**Snapshot rate:** `~/.local/bin/node tools/rate-sweep.mjs` compares 15 and 30 snapshots a second. Measured on 2026-10-23, with 2 rooms of 2 bots and 25 s per row:

| Snapshots/s | Network (one way) | Delay | Other fighter interpolated | Held still | Corrections |
|---|---|---|---|---|---|
| 15 | 40 ms, 10 ms jitter | 167 ms | 98.7% | 0% | 0 |
| 15 | 60 ms, 20 ms jitter | 167 ms | 98.4% | 0% | 0 |
| 15 | same + 2% loss (TCP stalls) | 167 ms | 93.4% | 3.3% | 0 |
| **30** (shipped) | 40 ms, 10 ms jitter | 83 ms | 99.4% | 0% | 0 |
| **30** (shipped) | 60 ms, 20 ms jitter | 83 ms | 99.4% | 0% | 0 |
| **30** (shipped) | same + 2% loss (TCP stalls) | 83 ms | 79.7% | 13.9% | 0 |

At 30 snapshots a second you aim at an opponent drawn half as far in the past, and on a normal connection the motion is smoother. That table is from before the interpolation delay adapted: now, on the lossy row, the delay grows to about 250 ms and the other fighter is interpolated on 85–92% of frames and held still on 3–7% (tests/online.test.mjs, tools/bot-match.mjs). If your friend still sees the other fighter freezing, set `snapshotHz` and `inputSendHz` to 15 in `js/game/sim.js`. The server and page share that file, so restart the server and reload.

## Debug and tuning

- `?debug`: a TUNING panel under the game (local play only) and the network overlay (toggle with **`**). Also `window.__game` with `state`, `step(n)`, `draw()`, `hold()`, `touch` (the touch router: `down`, `move`, `up`) and `view()`.
- `?sw`: turns the offline cache on at localhost, to try it. It's off there otherwise, so while you edit the game on this laptop you always get today's files.
- `?debug&lag=60,20,0.02`: runs this window's socket through a simulated network: one-way ms, jitter ms, loss.
- `?v=comeback`: the round loser starts the next round with a half-charged first dash. It's off by default and local play only, and it's there to playtest.
- All the numbers are in the `TUNING` block at the top of `js/game/sim.js`, with the ranges to try from DESIGN.md.

## Accessibility and settings

- Every menu uses real buttons. Arrow keys, Tab, Enter and Space work, Esc goes back or pauses, focus is always visible, and every button is at least 44 by 44 px (checked at phone size). A gamepad works in menus too: d-pad, A and B.
- Touch: the DASH button is about 100 px and the stick is the whole left half, both clear of the notch and the home bar. Pressing shows under your thumb. Left-handed mode swaps the sides, the touch controls can be forced on or off, made smaller or larger, switched to a fixed stick, and **Easy charge** turns the hold into two taps.
- A screen-reader live region announces joins, round results and the match result.
- Coral has stripes and a "1" badge, Teal has dots and a "2", so colour isn't the only difference.
- Settings has volume, mute, motion (follow the system, reduce, or full), screen shake strength, touch controls (auto, always, never), left-handed, touch control size, floating or fixed stick, easy charge, play over my music (iPhone), vibration (Android), your online name, and every key.
- Reduced motion turns off screen shake, slow motion, afterimages and the wobble. Cracking tiles get a hatch pattern instead. Hitstop stays, because it's a freeze, not movement. No more than 3 big flashes a second, and only a fighter flashes, never the screen.
- Every sound has something on screen to match, so the game works muted. Vibration is extra, never the only signal.
- Outside a match the page scrolls and zooms like any other. Only during play are scrolling, pinch-zoom, double-tap zoom, text selection and the long-press menu switched off on the game.

## Players' data

- Your settings, your key bindings, the rivalry tally and your record against the computer stay in this browser's storage (on a phone, in the Home Screen app's own storage). They never go anywhere. In a private window they're forgotten when it closes, and the game still works.
- An online display name (optional, up to 12 characters) lives only in the room's memory while the room exists. There's no chat.
- Server logs record the room code, tick and player id, never names or addresses.

## Files

```
index.html, css/game.css     the page
manifest.webmanifest, icons/ Add to Home Screen: the app's name, colours and icons
sw.js                        the offline cache (every file the game loads, versioned)
js/main.js                   screens, settings, the loop, which match is running
js/local.js, js/online.js    a match on this device; a match through the room server
js/solo.js                   your record against each computer opponent, and the Hard unlock (beat Skipper, or push it close 3 times)
js/render.js, js/audio.js    drawing and game feel; every sound, generated with Web Audio
js/controls.js               keys, gamepads and touch, by player and action
js/touch.js                  the floating stick and DASH button, one pad or two on one screen
js/haptics.js, js/pwa.js     vibration on Android; offline and the "new version" toast
js/game/sim.js               one fighter's step + TUNING (shared with the server)
js/game/rules.js             hits, clashes, the floe, rounds, the room adapter (shared)
js/game/cpu.js               the computer opponents: senses, decisions, virtual pad (shared)
js/net/                      client netcode from the multiplayer-web-games starter
server/                      server.mjs (page + rooms), ws.mjs (WebSockets), room.js, registry.js, sw-version.mjs
tools/                       bot.mjs, bot-match.mjs, rate-sweep.mjs, make-icons.mjs (draws the icons), stamp-sw.mjs
tests/                       node --test suites and the bot harness
```

The netcode in `js/net/` and `server/room.js` comes from the `multiplayer-web-games` starter. The loop and storage in `js/lib/` come from the `browser-games` starter.

## Play it anywhere (GitHub Pages and Render)

- **Play vs Computer and 2 players here:** https://eyallowy-stack.github.io/shove-off/ works on any device, no Tailscale needed. On an iPhone, open it in Safari, tap Share, then Add to Home Screen. After one visit it works offline too.
- **Online rooms** need the room server running somewhere public. It's set up for Render's free plan with `render.yaml`:

  [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/eyallowy-stack/shove-off)

  After it deploys, put the server's address (like `https://shove-off.onrender.com`) in `js/config.js`, add its `wss://` host to `connect-src` in `index.html`, and push. GitHub stamps the service worker and republishes by itself (`.github/workflows/pages.yml`). The free plan sleeps after 15 minutes without players, so the first person to join waits about a minute.
