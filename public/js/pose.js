// Pose extraction via MediaPipe Tasks Vision, running entirely in the browser
// on the GPU. Nothing about the video or your camera leaves the machine.
import { FilesetResolver, PoseLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

let filesetPromise = null;
function fileset() {
  filesetPromise ||= FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
  );
  return filesetPromise;
}

export async function createLandmarker() {
  return PoseLandmarker.createFromOptions(await fileset(), {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
}

const round = (n) => Math.round(n * 1e4) / 1e4;

// 12 samples a second is well above the rate at which choreography changes
// shape, and playback interpolates between them. The cap keeps a long routine
// from producing a pose file nobody wants to download.
const HZ = 12;
const MAX_SAMPLES = 2400;

// Step to an exact time and wait for the frame to be presented.
function seek(video, t) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 1e-3) return resolve();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', done);
      clearTimeout(timer);
      resolve();
    };
    // A seek past a damaged region can silently never fire; moving on with the
    // frame we have beats hanging the whole extraction.
    const timer = setTimeout(done, 2000);
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

/**
 * Walks the video frame by frame and records the dancer's pose at each step.
 *
 * Seeking rather than playing is deliberate. Browsers pause muted, video-only
 * playback whenever they decide the element is in the background — a tab
 * switch, an occluded window — which silently truncates a played extraction
 * with no error. Stepping is immune to all of that: it runs at the same speed
 * whether or not anyone is watching, and the user can go do something else.
 *
 * @param {HTMLVideoElement} video  loaded, with a known duration
 * @param {(progress: number, pose: number[][]|null) => void} [onProgress]
 */
export async function extractPoses(video, onProgress) {
  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('That video has no readable duration.');

  const landmarker = await createLandmarker();
  const count = Math.min(MAX_SAMPLES, Math.max(2, Math.ceil(duration * HZ)));
  const step = duration / count;
  const frames = [];

  video.pause();
  video.muted = true;

  try {
    for (let i = 0; i < count; i++) {
      const t = Math.min(duration - 1e-3, i * step);
      await seek(video, t);

      let pose = null;
      try {
        // Timestamps only have to increase; the wall clock always does.
        const result = landmarker.detectForVideo(video, performance.now());
        const lm = result.landmarks?.[0];
        if (lm) {
          pose = lm.map((p) => [round(p.x), round(p.y), round(p.z), round(p.visibility ?? 1)]);
          frames.push({ t: round(t), lm: pose });
        }
      } catch { /* a dropped frame is a gap poseAt() already knows how to cross */ }

      onProgress?.((i + 1) / count, pose);
    }
  } finally {
    landmarker.close();
  }

  if (frames.length < 2) throw new Error('No dancer was visible in that video.');
  // Landmarks are normalised per axis, so the source aspect has to travel with
  // them or the stickman comes out stretched.
  const aspect = video.videoWidth && video.videoHeight
    ? video.videoWidth / video.videoHeight
    : 16 / 9;
  return { version: 2, duration, aspect, frames };
}
