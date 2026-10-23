// Where online rooms live. Empty means the same address the game was loaded from: the
// room server itself (localhost, or your ts.net address through Tailscale). The copy on
// GitHub Pages can't run a server, so it points at the room server on Render instead,
// for example 'https://shove-off.onrender.com'. Add that host to connect-src in
// index.html too.
export const ROOM_SERVER = '';
