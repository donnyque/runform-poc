/**
 * RunForm PoC – MediaPipe Pose + Camera setup and skeleton overlay.
 * Uses front (selfie) camera, runs Pose on each frame, draws to canvas.
 */

import { Camera } from '@mediapipe/camera_utils';
import {
  drawConnectors,
  drawLandmarks,
  type NormalizedLandmarkList,
} from '@mediapipe/drawing_utils';
import {
  Pose,
  POSE_CONNECTIONS,
  type Results,
} from '@mediapipe/pose';
import {
  computeFrameQuality,
  getFrameQualityHint,
  type FrameQualityHint,
} from './frameQuality';

const MEDIAPIPE_POSE_VERSION = '0.5.1675469404';

export type PoseRunnerCallbacks = {
  onStatus: (
    fps: number,
    poseDetected: boolean,
    frameQuality: number | null,
    hint: FrameQualityHint | null
  ) => void;
  onError: (message: string) => void;
};

let pose: Pose | null = null;
let camera: Camera | null = null;
let animationId: number | null = null;
let lastStatusTime = 0;
let frameCount = 0;
let lastFps = 0;
let lastPoseDetected = false;
let lastFrameQuality: number | null = null;
let lastHint: FrameQualityHint | null = null;

function getLocateFile(): (path: string, prefix?: string) => string {
  return (path: string) => {
    return `https://cdn.jsdelivr.net/npm/@mediapipe/pose@${MEDIAPIPE_POSE_VERSION}/${path}`;
  };
}

function drawResults(ctx: CanvasRenderingContext2D, results: Results): void {
  const landmarks: NormalizedLandmarkList | undefined = results.poseLandmarks;
  if (!landmarks?.length) return;

  ctx.save();
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  drawConnectors(ctx, landmarks, POSE_CONNECTIONS, {
    color: '#00ff00',
    lineWidth: 2,
  });
  drawLandmarks(ctx, landmarks, {
    color: '#ff0000',
    fillColor: '#ff0000',
    lineWidth: 1,
    radius: 3,
  });
  ctx.restore();
}

export async function startPoseRunner(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  callbacks: PoseRunnerCallbacks
): Promise<void> {
  if (pose || camera) {
    await stopPoseRunner();
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    callbacks.onError('Kunne ikke hente canvas 2D context.');
    return;
  }

  try {
    pose = new Pose({
      locateFile: getLocateFile(),
    });
    pose.setOptions({
      selfieMode: true,
      modelComplexity: 1,
      smoothLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    pose.onResults((results: Results) => {
      const detected = Boolean(
        results.poseLandmarks && results.poseLandmarks.length > 0
      );
      lastPoseDetected = detected;
      if (detected) {
        lastFrameQuality = computeFrameQuality(results);
        lastHint = getFrameQualityHint(results);
      } else {
        lastFrameQuality = null;
        lastHint = null;
      }
      drawResults(ctx, results);
    });

    await pose.initialize();

    camera = new Camera(video, {
      facingMode: 'user',
      onFrame: async () => {
        if (video.videoWidth && video.videoHeight) {
          if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
          }
        }
        frameCount += 1;
        const now = performance.now();
        if (now - lastStatusTime >= 1000) {
          lastFps = Math.round((frameCount * 1000) / (now - lastStatusTime));
          frameCount = 0;
          lastStatusTime = now;
          callbacks.onStatus(lastFps, lastPoseDetected, lastFrameQuality, lastHint);
        }
        if (pose && video.readyState >= 2) {
          await pose.send({ image: video });
        }
      },
    });

    lastStatusTime = performance.now();
    frameCount = 0;
    await camera.start();

    if (video.videoWidth && video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    callbacks.onStatus(0, false, null, null);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Ukendt fejl ved start af kamera/pose.';
    callbacks.onError(message);
    await stopPoseRunner();
  }
}

export async function stopPoseRunner(): Promise<void> {
  if (animationId !== null) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
  if (camera) {
    try {
      await camera.stop();
    } catch {
      // ignore
    }
    camera = null;
  }
  if (pose) {
    try {
      await pose.close();
    } catch {
      // ignore
    }
    pose = null;
  }
}

export function resizeCanvasToVideo(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement
): void {
  if (video.videoWidth && video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
}
