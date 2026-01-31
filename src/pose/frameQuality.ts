/**
 * RunForm PoC – Frame quality score and hints from MediaPipe Pose landmarks.
 */

import {
  POSE_LANDMARKS,
  POSE_LANDMARKS_LEFT,
  POSE_LANDMARKS_RIGHT,
  type Results,
} from '@mediapipe/pose';

const KEY_LANDMARK_INDICES = [
  POSE_LANDMARKS.NOSE,
  POSE_LANDMARKS.LEFT_SHOULDER,
  POSE_LANDMARKS.RIGHT_SHOULDER,
  POSE_LANDMARKS.LEFT_HIP,
  POSE_LANDMARKS.RIGHT_HIP,
  POSE_LANDMARKS_LEFT.LEFT_KNEE,
  POSE_LANDMARKS_RIGHT.RIGHT_KNEE,
  POSE_LANDMARKS_LEFT.LEFT_ANKLE,
  POSE_LANDMARKS_RIGHT.RIGHT_ANKLE,
] as const;

const LEFT_KEY_INDICES = [
  POSE_LANDMARKS.LEFT_SHOULDER,
  POSE_LANDMARKS.LEFT_HIP,
  POSE_LANDMARKS_LEFT.LEFT_KNEE,
  POSE_LANDMARKS_LEFT.LEFT_ANKLE,
];

const RIGHT_KEY_INDICES = [
  POSE_LANDMARKS.RIGHT_SHOULDER,
  POSE_LANDMARKS.RIGHT_HIP,
  POSE_LANDMARKS_RIGHT.RIGHT_KNEE,
  POSE_LANDMARKS_RIGHT.RIGHT_ANKLE,
];

function getVisibility(landmarks: Results['poseLandmarks'], index: number): number {
  const lm = landmarks?.[index];
  return lm != null && typeof lm.visibility === 'number' ? lm.visibility : 0;
}

function avgVisibility(
  landmarks: Results['poseLandmarks'],
  indices: readonly number[]
): number {
  if (!landmarks?.length) return 0;
  let sum = 0;
  let count = 0;
  for (const i of indices) {
    const v = getVisibility(landmarks, i);
    sum += v;
    count += 1;
  }
  return count > 0 ? sum / count : 0;
}

export type FrameQualityHint = {
  shoulderWidthNormalized: number | null;
  noseAndAnklesOk: boolean;
};

/**
 * Compute frame quality score 0–100 from pose results.
 * VisibilityScore = avg visibility of key landmarks.
 * FullBodyBonus = +0.15 if nose and both ankles visibility > 0.6.
 * SymmetryPenalty = -0.10 if left vs right key visibility diff > 0.35.
 */
export function computeFrameQuality(results: Results): number {
  const landmarks = results.poseLandmarks;
  if (!landmarks?.length) return 0;

  const visibilityScore =
    KEY_LANDMARK_INDICES.reduce((s, i) => s + getVisibility(landmarks, i), 0) /
    KEY_LANDMARK_INDICES.length;

  const noseVis = getVisibility(landmarks, POSE_LANDMARKS.NOSE);
  const leftAnkleVis = getVisibility(landmarks, POSE_LANDMARKS_LEFT.LEFT_ANKLE);
  const rightAnkleVis = getVisibility(landmarks, POSE_LANDMARKS_RIGHT.RIGHT_ANKLE);
  const fullBodyBonus =
    noseVis > 0.6 && leftAnkleVis > 0.6 && rightAnkleVis > 0.6 ? 0.15 : 0;

  const leftAvg = avgVisibility(landmarks, LEFT_KEY_INDICES);
  const rightAvg = avgVisibility(landmarks, RIGHT_KEY_INDICES);
  const symmetryPenalty =
    Math.abs(leftAvg - rightAvg) > 0.35 ? -0.1 : 0;

  const raw =
    (visibilityScore + fullBodyBonus + symmetryPenalty) * 100;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * Hint for auto-check messages: shoulder width (normalized) and whether nose + ankles are ok.
 */
export function getFrameQualityHint(results: Results): FrameQualityHint {
  const landmarks = results.poseLandmarks;
  if (!landmarks?.length) {
    return { shoulderWidthNormalized: null, noseAndAnklesOk: false };
  }

  const leftShoulder = landmarks[POSE_LANDMARKS.LEFT_SHOULDER];
  const rightShoulder = landmarks[POSE_LANDMARKS.RIGHT_SHOULDER];
  const shoulderWidthNormalized =
    leftShoulder != null && rightShoulder != null
      ? Math.abs(leftShoulder.x - rightShoulder.x)
      : null;

  const noseVis = getVisibility(landmarks, POSE_LANDMARKS.NOSE);
  const leftAnkleVis = getVisibility(landmarks, POSE_LANDMARKS_LEFT.LEFT_ANKLE);
  const rightAnkleVis = getVisibility(landmarks, POSE_LANDMARKS_RIGHT.RIGHT_ANKLE);
  const noseAndAnklesOk =
    noseVis > 0.6 && leftAnkleVis > 0.6 && rightAnkleVis > 0.6;

  return { shoulderWidthNormalized, noseAndAnklesOk };
}

const CALIBRATION_MIN_VISIBILITY = 0.6;

/**
 * Calibration frame: mid hip Y, mid shoulder Y, and whether frame is good.
 * Good = pose + frameQuality >= 60 + hip/shoulder visibility >= 0.6.
 */
export type CalibrationFrameData = {
  midHipY: number | null;
  midShoulderY: number | null;
  isGood: boolean;
};

export function getCalibrationFrameData(
  results: Results,
  frameQuality: number
): CalibrationFrameData {
  const landmarks = results.poseLandmarks;
  if (!landmarks?.length || frameQuality < 60) {
    return { midHipY: null, midShoulderY: null, isGood: false };
  }

  const leftHip = landmarks[POSE_LANDMARKS.LEFT_HIP];
  const rightHip = landmarks[POSE_LANDMARKS.RIGHT_HIP];
  const leftShoulder = landmarks[POSE_LANDMARKS.LEFT_SHOULDER];
  const rightShoulder = landmarks[POSE_LANDMARKS.RIGHT_SHOULDER];

  const hipVisOk =
    getVisibility(landmarks, POSE_LANDMARKS.LEFT_HIP) >= CALIBRATION_MIN_VISIBILITY &&
    getVisibility(landmarks, POSE_LANDMARKS.RIGHT_HIP) >= CALIBRATION_MIN_VISIBILITY;
  const shoulderVisOk =
    getVisibility(landmarks, POSE_LANDMARKS.LEFT_SHOULDER) >= CALIBRATION_MIN_VISIBILITY &&
    getVisibility(landmarks, POSE_LANDMARKS.RIGHT_SHOULDER) >= CALIBRATION_MIN_VISIBILITY;

  const midHipY =
    leftHip != null && rightHip != null
      ? (leftHip.y + rightHip.y) / 2
      : null;
  const midShoulderY =
    leftShoulder != null && rightShoulder != null
      ? (leftShoulder.y + rightShoulder.y) / 2
      : null;

  const isGood =
    hipVisOk &&
    shoulderVisOk &&
    midHipY != null &&
    midShoulderY != null;

  return { midHipY, midShoulderY, isGood };
}

const METRICS_MIN_FRAME_QUALITY = 55;

/**
 * Tracking frame for metrics: best-leg ankle/knee Y and visibility, mid hip Y.
 * Only when pose + frameQuality >= 55.
 * Best leg = higher ankle visibility (L vs R). Step detection can use ankle or knee by visibility.
 */
export type TrackingFrameData = {
  ankleY: number;
  kneeY: number;
  ankleVis: number;
  kneeVis: number;
  ankleUsed: 'L' | 'R';
  midHipY: number;
} | null;

export function getTrackingFrameData(
  results: Results,
  frameQuality: number
): TrackingFrameData {
  const landmarks = results.poseLandmarks;
  if (!landmarks?.length || frameQuality < METRICS_MIN_FRAME_QUALITY) {
    return null;
  }

  const leftAnkleVis = getVisibility(landmarks, POSE_LANDMARKS_LEFT.LEFT_ANKLE);
  const rightAnkleVis = getVisibility(landmarks, POSE_LANDMARKS_RIGHT.RIGHT_ANKLE);
  const useLeft = leftAnkleVis > rightAnkleVis;

  const ankleIndex = useLeft
    ? POSE_LANDMARKS_LEFT.LEFT_ANKLE
    : POSE_LANDMARKS_RIGHT.RIGHT_ANKLE;
  const kneeIndex = useLeft
    ? POSE_LANDMARKS_LEFT.LEFT_KNEE
    : POSE_LANDMARKS_RIGHT.RIGHT_KNEE;

  const ankle = landmarks[ankleIndex];
  const knee = landmarks[kneeIndex];
  if (ankle == null || knee == null) return null;

  const ankleVis = getVisibility(landmarks, ankleIndex);
  const kneeVis = getVisibility(landmarks, kneeIndex);

  const leftHip = landmarks[POSE_LANDMARKS.LEFT_HIP];
  const rightHip = landmarks[POSE_LANDMARKS.RIGHT_HIP];
  const midHipY =
    leftHip != null && rightHip != null
      ? (leftHip.y + rightHip.y) / 2
      : 0;

  return {
    ankleY: ankle.y,
    kneeY: knee.y,
    ankleVis,
    kneeVis,
    ankleUsed: useLeft ? 'L' : 'R',
    midHipY,
  };
}
