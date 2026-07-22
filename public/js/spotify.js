// Spotify connect — Authorization Code with PKCE, entirely in the browser.
// No client secret exists anywhere in this project; the token lives in
// localStorage on the dancer's own device.
//
// What we use it for: who you are, and what you actually listen to. Your top
// artists become the seed for routine suggestions, and your profile turns the
// party lobby from a list of strangers into a room of people with taste.

const KEY = 'choreo.spotify';
const VERIFIER = 'choreo.spotify.verifier';
const SCOPES = 'user-read-email user-top-read user-read-recently-played';

const store = {
  get() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } },
  set(v) { localStorage.setItem(KEY, JSON.stringify(v)); },
  clear() { localStorage.removeItem(KEY); },
};

export function clientId() {
  return localStorage.getItem('choreo.spotify.clientId') || window.CHOREO_SPOTIFY_CLIENT_ID || null;
}
export function setClientId(id) {
  if (id) localStorage.setItem('choreo.spotify.clientId', id.trim());
  else localStorage.removeItem('choreo.spotify.clientId');
}

const redirectUri = () => `${location.origin}/`;

function randomString(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return btoa(String.fromCharCode(...bytes)).replace(/[^a-zA-Z0-9]/g, '').slice(0, n);
}
async function challenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function login() {
  const id = clientId();
  if (!id) throw new Error('Add a Spotify client ID in Settings first.');
  const verifier = randomString(96);
  sessionStorage.setItem(VERIFIER, verifier);
  const params = new URLSearchParams({
    client_id: id,
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: await challenge(verifier),
  });
  location.href = `https://accounts.spotify.com/authorize?${params}`;
}

// Called on boot: if we came back from Spotify, trade the code for a token.
export async function handleRedirect() {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  if (!code) return false;
  const verifier = sessionStorage.getItem(VERIFIER);
  history.replaceState({}, '', url.pathname + url.hash);
  if (!verifier) return false;

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId(),
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  });
  if (!res.ok) return false;
  const tok = await res.json();
  store.set({ ...tok, expiresAt: Date.now() + tok.expires_in * 1000 });
  sessionStorage.removeItem(VERIFIER);
  return true;
}

async function token() {
  const t = store.get();
  if (!t) return null;
  if (Date.now() < t.expiresAt - 30_000) return t.access_token;
  if (!t.refresh_token) { store.clear(); return null; }
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId(), grant_type: 'refresh_token', refresh_token: t.refresh_token,
    }),
  });
  if (!res.ok) { store.clear(); return null; }
  const next = await res.json();
  store.set({ ...t, ...next, expiresAt: Date.now() + next.expires_in * 1000 });
  return next.access_token;
}

export const isConnected = () => !!store.get();
export function logout() { store.clear(); localStorage.removeItem('choreo.spotify.profile'); }

async function api(path) {
  const t = await token();
  if (!t) return null;
  const res = await fetch(`https://api.spotify.com/v1${path}`, { headers: { Authorization: `Bearer ${t}` } });
  if (!res.ok) return null;
  return res.json();
}

// Profile + taste, cached for a day — this data changes slowly and we'd rather
// not spend a round trip on every page view.
export async function profile({ force = false } = {}) {
  const cached = JSON.parse(localStorage.getItem('choreo.spotify.profile') || 'null');
  if (!force && cached && Date.now() - cached.at < 24 * 3600 * 1000) return cached;
  if (!isConnected()) return null;

  const [me, artists, tracks] = await Promise.all([
    api('/me'),
    api('/me/top/artists?limit=8&time_range=short_term'),
    api('/me/top/tracks?limit=12&time_range=short_term'),
  ]);
  if (!me) return cached;

  const data = {
    at: Date.now(),
    name: me.display_name || 'Dancer',
    image: me.images?.[0]?.url || null,
    artists: (artists?.items || []).map((a) => ({ name: a.name, genres: a.genres?.slice(0, 2) || [], image: a.images?.[2]?.url })),
    tracks: (tracks?.items || []).map((t) => ({
      name: t.name,
      artist: t.artists.map((a) => a.name).join(', '),
      image: t.album?.images?.[2]?.url,
    })),
  };
  localStorage.setItem('choreo.spotify.profile', JSON.stringify(data));
  return data;
}

// The one-line read on your taste, used as the lobby subtitle. Genres are
// messy strings ("k-pop girl group"), so we take the most common word stem.
export function vibe(p) {
  if (!p?.artists?.length) return null;
  const counts = new Map();
  for (const a of p.artists) {
    for (const g of a.genres) {
      for (const w of g.split(/[\s-]+/)) {
        if (w.length < 3 || ['and', 'the', 'pop'].includes(w)) continue;
        counts.set(w, (counts.get(w) || 0) + 1);
      }
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const label = top ? top[0] : p.artists[0].genres[0];
  return label ? label.replace(/\b\w/g, (c) => c.toUpperCase()) : null;
}

// Your top tracks, phrased as YouTube searches — the fastest path from "what I
// listen to" to "a routine I'd actually want to learn".
export function suggestions(p, n = 6) {
  if (!p?.tracks?.length) return [];
  return p.tracks.slice(0, n).map((t) => ({
    ...t,
    query: `${t.artist} ${t.name} dance choreography`,
    search: `https://www.youtube.com/results?search_query=${encodeURIComponent(`${t.artist} ${t.name} dance choreography`)}`,
  }));
}
