// Pose extraction via MediaPipe Tasks Vision, running entirely in the browser (WebGL).
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

// Plays the video muted and records one pose per decoded frame.
// Frame drops are fine — playback interpolates between keyframes.
export async function extractPoses(video, onProgress) {
  const landmarker = await createLandmarker();
  const frames = [];
  video.muted = true;
  video.currentTime = 0;
  video.playbackRate = 1;

  await new Promise((resolve, reject) => {
    let lastVideoTime = -1;
    const onFrame = (_now, meta) => {
      if (video.ended) return;
      const t = meta.mediaTime;
      if (t !== lastVideoTime) {
        lastVideoTime = t;
        const result = landmarker.detectForVideo(video, performance.now());
        const lm = result.landmarks?.[0];
        if (lm) {
          frames.push({
            t: round(t),
            lm: lm.map((p) => [round(p.x), round(p.y), round(p.z), round(p.visibility ?? 1)]),
          });
        }
        onProgress?.(t / video.duration);
      }
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    video.onended = resolve;
    video.onerror = () => reject(new Error('Video playback failed during extraction.'));
    video.play().catch(reject);
  });

  landmarker.close();
  video.onended = null;
  return { version: 1, duration: video.duration, frames };
}
