# Choreo

Paste a YouTube link to a dance. Choreo pulls the video, tracks the dancer's
body, finds the part of the routine that repeats — the hookstep — and redraws it
as a stickman you can slow down, mirror and loop until it's in your body.

Then it turns on your camera and scores you against it move for move — and counts
the calories while you go. Dance alone, or in a room with your friends. It's a
rhythm game and a cardio workout wearing the same clothes.

The home screen opens on a **Trending** feed of dance challenges that are
actually going around this week, refreshed automatically, so there's always
something to learn without hunting for a link.

Everything except the video download runs in your browser. No pose data, and no
camera frame, ever leaves the machine.

## Running it

Requires Node 18+ and [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) on your PATH.

```sh
brew install yt-dlp     # or: pipx install yt-dlp
npm install
npm start               # http://localhost:4173
```

Battle mode needs a camera, and browsers only grant camera access over HTTPS or
on `localhost`. Opening the app by LAN IP will silently fail to get a webcam.

## How it works

**Pose extraction** (`public/js/pose.js`) plays the downloaded video through
MediaPipe Pose in a WebGL context and records 33 landmarks per frame. It runs
once per video; the result is cached on the server so the second visit is
instant. A 3-minute video takes roughly 30–60 seconds on an M-series Mac.

**Hookstep detection** (`public/js/hook.js`) is the part that took the most
care. The idea is simple — find the lag at which the routine best rhymes with a
shifted copy of itself — but two things break a naive autocorrelation:

- Bodies move slowly, so any two samples a tenth of a second apart look nearly
  identical and the shortest lag always wins. We detrend each lag against a
  local baseline and take the most *prominent* peak rather than the highest raw
  correlation.
- Title cards, logo stings and frames where the dancer has walked off are
  perfectly self-similar, which makes them irresistible to a matcher. Every
  sample carries a liveness flag; dead and motionless stretches are excluded
  from both the correlation and the candidate windows.

There's also octave correction: an eight-count that repeats necessarily repeats
at four, so the half-length peak is always present. When the longer phrase is
nearly as strong we prefer it, because that's the unit dancers actually count.

**Scoring** (`comparePoses` in `public/js/stickman.js`) compares bone
*directions*, not positions, so where you stand and how far you are from the
camera don't matter. The learner's pose is mirrored limb-for-limb — left arm
compared against the reference's right — so copying face-to-face, the way you
would in a studio, scores the same as copying side-on. Getting this wrong marks
correct dancing as wrong, which is why there are tests pinning it down.

## What's in it

- **Studio** — video and stickman side by side and in sync, variable speed,
  mirror, auto-cut steps, loop any region.
- **Battle** — count-in, live per-frame scoring against the routine, judgements
  and a combo meter, results screen, local leaderboard per video.
- **Party** — a room code, everyone on their own phone, a synchronised start and
  a live leaderboard. Ephemeral: the room lives as long as someone is in it.
- **Trending** — a rolling feed of dance challenges circulating now. Keyless by
  default (yt-dlp search); set `YOUTUBE_API_KEY` to power it from YouTube's real
  most-popular-Music chart. Cached to disk, refreshed every 6 hours.
- **Fitness** — every routine has a calorie and intensity estimate, live during
  a battle and totalled after. Daily streaks, lifetime kcal and active minutes.
  Set your body weight in Settings to sharpen the estimate; it stays on-device.
- **Related routines** — a search for slower, mirrored tutorials of the same
  song, for when the original is too fast to read.
- **Spotify** (optional) — connect for profile and top tracks. Uses PKCE, so
  only a client id is needed and no secret touches the server. Set
  `SPOTIFY_CLIENT_ID`, or paste one in the app. Without it the rest still works.

## Calorie estimate — how, and how much to trust it

Pose landmarks are normalised to the video frame, so raw motion depends on how
much of the shot the dancer fills. Choreo divides every limb displacement by
torso length, giving speed in *body-lengths per second* — independent of camera
distance. That maps to a MET (metabolic equivalent) between a slow sway and
all-out choreography, and MET × body-mass × time is the calorie estimate physios
use for cardio.

It's a genuine estimate, not a measurement. It can't see how deep you squat or
what you actually weigh, and it reads effort only from limb speed. Trust it as a
*consistent relative score* — good for "harder than yesterday" and streaks — not
as a clinical calorimeter.

## Tests

```sh
npm test
```

20 tests over the parts where being wrong is silent rather than loud: mirror
handling in scoring, interpolation bounds, hookstep confidence across recorded
routines, step segmentation covering the routine without gaps, tempo landing in
a range people actually dance to, and the fitness math — intensity monotonic and
bounded, calories linear in body mass, leap-year-correct streak dates, and real
routines landing in a human kcal/min range.

## Status

Honest account of what has and hasn't been exercised:

- Verified end to end in a browser: link → download → extraction → studio;
  hookstep detection against three real routines (a Bollywood number, a K-pop
  cover, a studio choreography), which found 4.2s / 6.4s / 8.9s phrases; the
  Trending feed pulling real current tutorials; and home/settings rendering
  clean with no console errors.
- **Not yet run live: battle mode and party rooms.** The scoring and calorie
  math is unit-tested and the room protocol is written, but the camera loop, the
  live burn HUD, and the multiplayer session have not been executed against a
  real camera or a second device. Expect bugs there.
- Spotify is untested — it needs a real client id and account. A `YOUTUBE_API_KEY`
  is optional; without it Trending runs on keyless yt-dlp search, which is what
  was tested.
