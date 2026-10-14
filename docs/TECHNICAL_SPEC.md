# Shadow: Technical Specification

**Version:** 0.2.0 · **Status:** working prototype · **Owner:** Amritha S

Shadow teaches dance choreography from any YouTube video. It turns the dancer
into a stickman you can slow down, mirror and loop. It scores you live on
camera, shows you which limb is wrong while you dance, and finishes with an AI
coach that writes you one specific practice plan.

---

## 1. Who it's for and what problem it solves

**Users:** people who want to learn a trending dance (a K-pop chorus, a
Bollywood hookstep, a viral challenge) from a video, without a teacher.

**The problem:** dance videos are hard to learn from.
- They are too fast to read.
- They aren't mirrored, so the learner has to swap left and right in their head.
- There are costumes, cuts and camera moves in the way.
- Nobody tells you *what* you're getting wrong.

**What Shadow does about it:**

| Problem | Shadow's answer |
|---|---|
| Too fast, too cluttered | A clean stickman of the dancer, at 0.25×–1× speed |
| Not mirrored | One-tap mirror that swaps sides correctly, not just a flipped image |
| Don't know where to start | Auto-detected hookstep, plus auto-cut steps |
| Don't know if you're right | Live camera scoring against the dancer |
| Don't know *what's* wrong | Wrong limbs turn red live, a per-step report afterwards, and an AI coach plan |

---

## 2. Features

| Feature | What the user gets | Status |
|---|---|---|
| **Link to routine** | Paste a YouTube link; the video downloads and the dancer's pose is extracted | Verified end to end (see §9) |
| **Studio** | Video and stickman in sync, speed 0.25–1×, mirror, loop any region, auto-cut steps | Verified |
| **Hookstep detection** | Finds the phrase that repeats and opens on it | Verified on 3 real routines |
| **Battle** | Count-in, live scoring, judgements (PERFECT…MISS), combo meter, rank S–D | Verified |
| **Live limb feedback** | Your limbs turn red on screen when they are more than ~50° off the dancer's | Unit-tested; not yet run with a real camera |
| **Step-by-step report** | Accuracy per step, the limb missed most, "not seen" for steps you were out of frame | Unit-tested; results screen rendered in a browser |
| **AI coach** | An agent reviews your run and writes one plan: which step, which cues, what speed, how many loops, and what improved | Agent loop tested with a scripted model; **not yet run against the live Claude API** |
| **Coach memory** | Each run is remembered per routine, so the coach can say "Step 2: 25% → 38%" | Verified through the server route |
| **Drill button** | Opens the Studio looping the coach's chosen step at the coach's chosen speed | Rendered; click-through not yet run with a real routine |
| **Party** | Room code, everyone on their own phone, synchronised start, live leaderboard | Written; **never run with two devices** |
| **Trending** | Feed of dance challenges circulating now, refreshed every 6 h | Verified (keyless mode) |
| **Fitness** | Calorie and intensity estimate, daily streak | Unit-tested |
| **Spotify** | Optional profile and top tracks | **Untested** |

---

## 3. Where AI is used, and why each piece is needed

Shadow uses three kinds of AI. Each one does something that ordinary code
couldn't.

### 3.1 Computer vision: pose estimation (MediaPipe Pose Landmarker)
- **What:** finds 33 body landmarks per frame, in the dancer's video and in your
  webcam.
- **Where it runs:** in the browser (WebGL / WASM). No video frame and no pose
  data leaves the machine.
- **Why it's needed:** there is no other way to get a skeleton out of an
  ordinary video.

### 3.2 Signal analysis on top of the poses (Shadow's own algorithms)
- **Hookstep detection:** a detrended autocorrelation with liveness masking and
  octave correction finds the repeating phrase.
- **Scoring:** compares bone *directions*, so where you stand and how big you
  look don't matter. Mirroring swaps the body's sides, not just the x axis.
- **Joint angles:** elbow, shoulder, hip and knee angles for you and the dancer
  at every judgement, corrected for the frame's aspect ratio.

### 3.3 Agentic generative AI: the coach (Claude, through the Anthropic SDK)
An agent with tools that decides what to look at, rather than a single prompt.

```
 Browser                              Server (Node)                     Claude
 ───────                              ─────────────                     ──────
 battle ends
 step report ─── POST /api/coach/:id ─▶ sanitise report
 (per-step accuracy,                    load memory (past runs)
  limb scores,                          agent loop ─────── messages + tools ──▶
  joint angles you vs them)                │                                 decides which
                                           │◀────── tool_use ───────────────  tool to call
                                           │ run tool locally
                                           │ ─────── tool_result ──────────▶
                                           │          … repeats …
                                           │◀────── submit_plan ────────────
                                        validate plan
                                        save this run to memory
 coach card ◀──── plan + trace ─────────
```

**The agent's tools:**

| Tool | What it returns | Kind |
|---|---|---|
| `get_step_report` | Every step: time range, accuracy, weakest limb | Read data |
| `get_step_detail` | One step: per-limb scores and every joint off by ≥ 20°, with a plain-English reading | Read data |
| `get_past_attempts` | This learner's previous runs on this routine, per step | **Memory** |
| `lookup_technique` | Teaching cues ranked for one joint and one problem | **Retrieval** (from `coach-cues.js`) |
| `submit_plan` | The final plan; strict schema, validated before it is shown | Structured output |

**Design decisions:**
- **Every number comes from a tool.** The system prompt forbids inventing scores
  or angles. The tools pre-compute readings like "your left elbow is straighter
  than the dancer's by 76°", so the model never has to interpret a sign.
- **Untrusted input is clamped.** The browser's report is sanitised to fixed
  sizes and ranges before any tool reads it.
- **Bad calls are recoverable.** A wrong step label returns an error listing
  the valid labels, and the agent retries. The UI trail marks the retry.
- **Plans are validated.** A plan naming a step that doesn't exist is rejected
  and never shown.
- **It degrades gracefully.** With no API credentials, a refusal, or any API
  error, a rule-based offline coach produces the same plan shape from the same
  data. The card clearly says "Offline coach (rule-based)" instead of "AI coach".
- **Refusal fallback:** requests opt into server-side fallback
  (`fallbacks: "default"`), so a safety decline is re-run on Anthropic's
  recommended fallback model instead of failing.
- **Transparency:** the card has a "How the coach got here" trail listing every
  tool call.

**What the retrieval and memory honestly are:** the "knowledge base" is a small,
hand-written library of 16 teaching cues, ranked by joint and problem match.
There are no embeddings and no vector database; at this size they would add
nothing. The memory is a per-routine JSON file of past runs. Neither of them
trains or changes any model. Section 10 covers what could be added later.

---

## 4. Architecture

| Layer | Technology | Responsibility |
|---|---|---|
| Client | Vanilla ES modules, Canvas 2D, no framework | UI, pose extraction, scoring, drawing |
| Vision | MediaPipe Tasks Vision 0.10.14 (CDN), Pose Landmarker Lite | 33-point pose per frame |
| Server | Node 18+, Express 4, `ws` 8 | Video download, caches, scores, party relay, coach |
| Video fetch | `yt-dlp` (system binary) | Download the YouTube video |
| Coach | `@anthropic-ai/sdk`, model `claude-opus-5-5` (override with `SHADOW_COACH_MODEL`) | Agentic coaching |
| Storage | JSON files under `data/` (git-ignored) | Videos, poses, metadata, scores, coach memory, trending cache |

**Key files:**

| File | Purpose |
|---|---|
| `server.js` | HTTP routes, party WebSocket, coach route and memory |
| `coach.js` | Agent loop, tools, input sanitising, offline coach |
| `coach-cues.js` | Retrieval library of teaching cues |
| `trending.js` | Trending feed (yt-dlp search or YouTube Data API) |
| `public/js/pose.js` | MediaPipe extraction |
| `public/js/hook.js` | Hookstep and tempo detection |
| `public/js/stickman.js` | Drawing, interpolation, mirroring, scoring, step segmentation, joint angles, step report |
| `public/js/battle.js` | Live battle engine and live limb colouring |
| `public/js/studio.js` | Practice studio |
| `public/js/app.js` | Routing, screens, results, coach card |
| `public/js/fitness.js` | Calorie and streak maths |
| `public/js/party.js` | Party client |

---

## 5. HTTP API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/videos` | Start downloading a YouTube URL |
| `GET` | `/api/videos/:id/status` | Download progress |
| `GET` / `POST` | `/api/videos/:id/poses` | Read / cache extracted pose data |
| `GET` | `/api/videos/:id/similar` | Slower or mirrored tutorials of the same song |
| `GET` | `/api/library` | Routines already on this machine |
| `GET` | `/api/trending` | Trending dance feed |
| `GET` / `POST` | `/api/scores/:id` | Leaderboard for a routine |
| `POST` | `/api/coach/:id` | **Coach a finished battle** (below) |
| `GET` | `/api/config` | Client config, including whether the coach is enabled and which model |
| WS | `/` | Party rooms |

**`POST /api/coach/:id`**

Request body:
```json
{ "report": { "title": "…", "accuracy": 52, "rank": "C",
  "steps": [{ "label": "Step 2", "start": 2.1, "end": 4.4, "accuracy": 36,
              "worst": "left arm", "judged": 5,
              "limbs": { "left arm": 50 },
              "joints": { "left elbow": { "you": 168, "ref": 92 } } }] } }
```

Response body:
```json
{ "plan": { "headline": "…", "focus": { "label": "Step 2", "start": 2.1, "end": 4.4, "accuracy": 36 },
            "why": "…", "cues": ["…"], "speed": 0.5, "loops": 8, "progress": "…" },
  "trace": [{ "tool": "get_step_report", "input": {}, "ok": true }],
  "source": "claude" | "offline", "model": "…", "reason": "why offline, if it was" }
```

---

## 6. Requirements

### 6.1 To run it

| Requirement | Detail |
|---|---|
| Node.js | 18 or newer (developed on 22) |
| yt-dlp | On `PATH` (`brew install yt-dlp` or `pipx install yt-dlp`) |
| Browser | Recent Chrome, Edge or Safari with WebGL |
| Camera | Needed for Battle; browsers allow it only on `localhost` or HTTPS |
| Network | YouTube, `cdn.jsdelivr.net` and `storage.googleapis.com` (MediaPipe); `api.anthropic.com` for the AI coach |
| Hardware | Any recent laptop; pose extraction takes roughly 30–60 s per 3-minute video on an M-series Mac |

### 6.2 Configuration (environment variables)

| Variable | Required | Effect |
|---|---|---|
| `ANTHROPIC_API_KEY` | For the AI coach | Without it (or an `ant auth login` profile), the offline coach answers |
| `SHADOW_COACH_MODEL` | No | Overrides the coach model (default `claude-opus-5-5`) |
| `SHADOW_COACH` | No | `offline` forces the rule-based coach |
| `YOUTUBE_API_KEY` | No | Powers Trending from YouTube's most-popular chart |
| `SPOTIFY_CLIENT_ID` | No | Enables the optional Spotify connection |
| `PORT` | No | Default 4173 |

### 6.3 Functional requirements

| ID | Requirement |
|---|---|
| F1 | Accept a YouTube link and produce a playable routine with pose data |
| F2 | Show the dancer as a stickman, synced to the video, at 0.25–1× speed, mirrorable |
| F3 | Split the routine into steps automatically and find the hookstep |
| F4 | Score a learner live from the webcam, independent of where they stand |
| F5 | Mark a mirrored copy as correct (face-to-face learning) |
| F6 | Highlight off-target limbs live during a battle |
| F7 | Report accuracy per step, and never report a step the camera didn't see as 0% |
| F8 | Produce one practice plan per battle, grounded only in measured data |
| F9 | Remember past attempts per routine and report change over time |
| F10 | Keep working (offline coach) without AI credentials |

### 6.4 Non-functional requirements

| ID | Requirement |
|---|---|
| N1 | **Privacy:** camera frames and pose data never leave the browser. The coach receives only aggregate step numbers. |
| N2 | **Responsiveness:** drawing never waits on inference (separate render and detection loops) |
| N3 | **Honesty:** every number the coach shows traces to a measurement; the UI labels offline vs AI coaching |
| N4 | **Robustness:** a failed coach call falls back; a malformed report is clamped, not trusted |
| N5 | **Mobile:** layouts work at phone width with no horizontal scroll |

---

## 7. Data stored (all local, under `data/`, git-ignored)

| Path | Contents |
|---|---|
| `videos/<id>.mp4` | Downloaded video |
| `poses/<id>.json` | Extracted landmarks per frame |
| `meta/<id>.json` | Title, duration, thumbnail |
| `scores.json` | Leaderboards |
| `coach/<id>.json` | Coach memory: the last 30 runs' per-step accuracy |
| `trending.json` | Trending cache |

---

## 8. Testing

Run with `npm test` (Node's built-in test runner).

| File | Covers |
|---|---|
| `test/scoring.test.mjs` | Mirror handling, interpolation, hookstep confidence, segmentation, tempo. **Needs recorded routines in `data/poses`; skips itself without them.** |
| `test/fitness.test.mjs` | Intensity bounds, calorie maths, streak dates |
| `test/steps.test.mjs` | Step bucketing, boundaries, null for unseen steps, limb mapping |
| `test/coach.test.mjs` | Joint angles and aspect, input sanitising, joint readings, retrieval ranking, memory, strict schemas, and the full agent loop against a scripted model: investigating, recovering from a bad tool call, parallel tool calls, rejecting an invalid plan, refusal handling, offline coach |

**Last run: 30 tests, 30 passed** (the runner prints 31 because it counts the
skipped `scoring.test.mjs` file as one passing entry). The 11 tests in
`scoring.test.mjs` didn't run, because this checkout has no recorded routines.

---

## 9. Verification status

**Verified:**
- Link → download → extraction → studio, in a browser.
- Hookstep detection on three real routines (4.2 s, 6.4 s, 8.9 s phrases).
- Solo battle end to end, with a routine video fed in as a synthetic camera.
- Trending feed (keyless).
- Coach route: offline plan, memory persisted, and "before → now" progress
  reported on the second run.
- Results screen with the coach card and step report rendered in Chromium at
  desktop and phone width, with no console errors and no horizontal overflow.

**Not yet verified:**
- **The coach against the live Claude API.** No key was available in the build
  environment. The loop is tested with a scripted model only.
- Live red-limb highlighting with a real person on camera.
- The Drill button click-through with a real routine.
- Party mode with two devices.
- Spotify.

---

## 10. Known limitations and next steps

- **2D only.** Joint angles come from a single camera, so a limb pointing at the
  lens reads shorter and its angle is less reliable.
- **One dancer.** Multi-dancer videos track the most prominent person.
- **The coach sees numbers, not video.** It can't comment on style, facial
  expression or timing feel.
- **Small cue library (16 cues).** It's easy to extend in `coach-cues.js`, and
  embedding-based retrieval becomes worthwhile once it reaches hundreds.
- **Next:** stream the coach's tool calls to the UI as they happen; run the coach
  against the live API and tune its effort level; let the coach pick a slower
  tutorial from the Trending/similar search.

---

## 11. Hackathon submission checklist (Build With AI: Basics)

| Requirement | Status |
|---|---|
| Public repo | `github.com/Amritha902/shadow` is public |
| 1–3 min demo video | **To do.** Show: link → stickman → mirror → battle with red limbs → step report → AI coach → Drill |
| Short description | **To do** |
| `scope.md`, `prd.md`, `spec.md` from the Devpost skill pack | **Missing.** These must be generated by running the skill pack, not written by hand |
| "Started from an empty folder during the submission period" | **Check the official rules.** Development predates this document; confirm the start date of the submission window before submitting |
