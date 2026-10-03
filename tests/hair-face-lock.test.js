import test from "node:test";
import assert from "node:assert/strict";
import {
  EYEBROW_INDICES,
  EYE_INDICES,
  FACE_OVAL_RING,
} from "../public/faceMask.js";
import {
  applyInverse,
  buildIdentityPolygon,
  faceAnchorPoints,
  fitTone,
  pointInPolygon,
  compositeLiveFace,
  compositeSyncedFace,
  polygonRegion,
  renderLockedPreview,
  similarityFromCorrespondences,
  transformPolygon,
} from "../public/hairFaceLock.js";
import { buildFaceMaskPolygon } from "../public/faceMask.js";
import { expressionFeatures, pickSyncedFrame } from "../public/liveFaceLock.js";

function landmarks({
  width = 48,
  height = 64,
  leftEye = { x: 0.36, y: 0.42 },
  rightEye = { x: 0.64, y: 0.42 },
  nose = { x: 0.5, y: 0.52 },
  mouth = { x: 0.5, y: 0.62 },
} = {}) {
  const marks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.55, z: 0 }));
  FACE_OVAL_RING.forEach((idx, i) => {
    const t = (i / FACE_OVAL_RING.length) * Math.PI * 2 - Math.PI / 2;
    marks[idx] = { x: 0.5 + Math.cos(t) * 0.2, y: 0.56 + Math.sin(t) * 0.28, z: 0 };
  });
  for (const i of EYEBROW_INDICES) marks[i] = { x: 0.5, y: 0.36, z: 0 };
  for (const i of EYE_INDICES) marks[i] = { x: 0.5, y: 0.44, z: 0 };
  for (const i of [33, 133, 159, 145]) marks[i] = { ...leftEye, z: 0 };
  for (const i of [263, 362, 386, 374]) marks[i] = { ...rightEye, z: 0 };
  marks[1] = { ...nose, z: 0 };
  marks[13] = { ...mouth, z: 0 };
  return { marks, width, height };
}

function fill(width, height, rgb) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return data;
}

function rgb(data, index) {
  const o = index * 4;
  return [data[o], data[o + 1], data[o + 2]];
}

function findPixel(width, height, predicate) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (predicate(x, y)) return y * width + x;
    }
  }
  return -1;
}

test("similarity maps styled face anchors onto the webcam face", () => {
  const src = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 16 }];
  const dst = [{ x: 4, y: 6 }, { x: 24, y: 6 }, { x: 14, y: 22 }];
  const transform = similarityFromCorrespondences(src, dst);
  assert.ok(transform);
  assert.ok(Math.abs(transform.scale - 1) < 1e-6);
  for (let i = 0; i < src.length; i++) {
    const back = applyInverse(transform, dst[i].x, dst[i].y);
    assert.ok(Math.abs(back.x - src[i].x) < 1e-6);
    assert.ok(Math.abs(back.y - src[i].y) < 1e-6);
  }
});

test("face anchors reject a collapsed eye pair", () => {
  const { marks, width, height } = landmarks({
    leftEye: { x: 0.5, y: 0.42 },
    rightEye: { x: 0.5, y: 0.42 },
  });
  assert.equal(faceAnchorPoints(marks, width, height), null);
  const blank = fill(width, height, [1, 2, 3]);
  assert.equal(renderLockedPreview({
    person: blank,
    styled: blank,
    personWidth: width,
    personHeight: height,
    styledWidth: width,
    styledHeight: height,
    personLandmarks: marks,
    styledLandmarks: marks,
  }), null);
});

test("identity polygon covers brows, full cheeks and jaw", () => {
  const { marks, width, height } = landmarks();
  const identity = buildIdentityPolygon(marks, width, height);
  const face = buildFaceMaskPolygon(marks, width, height);
  const top = (poly) => Math.min(...poly.map((p) => p.y));
  const left = (poly) => Math.min(...poly.map((p) => p.x));
  const right = (poly) => Math.max(...poly.map((p) => p.x));
  const browY = 0.36 * height;
  assert.ok(top(identity) < browY, "identity starts above the brow line");
  assert.ok(top(face) > browY, "reference mask polygon still starts below the brows");
  assert.ok(left(identity) < left(face) && right(identity) > right(face), "identity has no temple inset");
});

test("styled frame is the base; webcam face is blended back inside the identity oval", () => {
  const { marks, width, height } = landmarks();
  const person = fill(width, height, [200, 100, 50]);
  const styled = fill(width, height, [10, 20, 200]);
  const rendered = renderLockedPreview({
    person,
    styled,
    personWidth: width,
    personHeight: height,
    styledWidth: width,
    styledHeight: height,
    personLandmarks: marks,
    styledLandmarks: marks,
    featherRadius: 0,
    toneMatch: false,
  });
  assert.equal(rendered.mode, "face");
  const identity = buildIdentityPolygon(marks, width, height);
  const faceIndex = findPixel(width, height, (x, y) => pointInPolygon(x + 0.5, y + 0.5, identity) && y > 0.5 * height);
  const hairIndex = findPixel(width, height, (x, y) => y < 4);
  const bodyIndex = findPixel(width, height, (x, y) => y > height - 3);
  assert.ok(faceIndex >= 0 && hairIndex >= 0 && bodyIndex >= 0);
  assert.deepEqual(rgb(rendered.rgba, faceIndex), [200, 100, 50]);
  assert.deepEqual(rgb(rendered.rgba, hairIndex), [10, 20, 200]);
  assert.deepEqual(rgb(rendered.rgba, bodyIndex), [10, 20, 200]);
  assert.equal(rendered.faceMask.length, width * height);
  assert.equal(rendered.faceMask[faceIndex], 1);
  assert.equal(rendered.faceMask[hairIndex], 0);
  assert.equal(rendered.faceMask[bodyIndex], 0);
});

test("styled hair drawn over the face (bangs) keeps the styled frame", () => {
  const { marks, width, height } = landmarks();
  const person = fill(width, height, [200, 100, 50]);
  const styled = fill(width, height, [10, 20, 200]);
  const identity = buildIdentityPolygon(marks, width, height);
  const topY = Math.min(...identity.map((p) => p.y));
  // Styled hair covers the top band of the identity region (brows) and everything above.
  const hair = new Uint8Array(width * height);
  for (let y = 0; y < Math.ceil(topY) + 4; y++) for (let x = 0; x < width; x++) hair[y * width + x] = 1;
  const rendered = renderLockedPreview({
    person,
    styled,
    personWidth: width,
    personHeight: height,
    styledWidth: width,
    styledHeight: height,
    personLandmarks: marks,
    styledLandmarks: marks,
    styledHair: hair,
    featherRadius: 0,
    toneMatch: false,
  });
  const browIndex = findPixel(width, height, (x, y) => pointInPolygon(x + 0.5, y + 0.5, identity) && hair[y * width + x] && y < topY + 2);
  const chinIndex = findPixel(width, height, (x, y) => pointInPolygon(x + 0.5, y + 0.5, identity) && y > 0.7 * height);
  assert.ok(browIndex >= 0 && chinIndex >= 0);
  assert.equal(rendered.faceMask[browIndex], 0, "bangs stay the styled frame");
  assert.deepEqual(rgb(rendered.rgba, chinIndex), [200, 100, 50]);
});

test("webcam face is aligned onto a shifted styled head", () => {
  const personFace = landmarks();
  const { width, height } = personFace;
  const shift = 6 / width;
  const styledFace = landmarks({
    leftEye: { x: 0.36 - shift, y: 0.42 },
    rightEye: { x: 0.64 - shift, y: 0.42 },
    nose: { x: 0.5 - shift, y: 0.52 },
    mouth: { x: 0.5 - shift, y: 0.62 },
  });
  const person = fill(width, height, [200, 100, 50]);
  const styled = fill(width, height, [9, 8, 7]);
  // Marker column in the styled frame at x < 20 → lands at x < 26 in webcam coordinates.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < 20; x++) {
      const o = (y * width + x) * 4;
      styled[o] = 1;
      styled[o + 1] = 2;
      styled[o + 2] = 3;
    }
  }
  const rendered = renderLockedPreview({
    person,
    styled,
    personWidth: width,
    personHeight: height,
    styledWidth: width,
    styledHeight: height,
    personLandmarks: personFace.marks,
    styledLandmarks: styledFace.marks,
    featherRadius: 0,
    toneMatch: false,
  });
  assert.ok(rendered);
  assert.ok(Math.abs(rendered.transform.tx - 6) < 1e-6);
  const index = 2 * width + 22;
  assert.deepEqual(rgb(rendered.rgba, index), [1, 2, 3]);
  // Just outside the styled frame (left edge after the shift) its edge pixels are extended, not the webcam photo.
  assert.deepEqual(rgb(rendered.rgba, 2 * width + 1), [1, 2, 3]);
});

test("live overlay keeps Lucy outside the face and the webcam inside it", () => {
  const { marks, width, height } = landmarks();
  const base = fill(width, height, [10, 20, 200]);
  const face = fill(width, height, [200, 100, 50]);
  const rendered = compositeLiveFace({
    base,
    baseWidth: width,
    baseHeight: height,
    baseLandmarks: marks,
    face,
    faceWidth: width,
    faceHeight: height,
    faceLandmarks: marks,
    featherRadius: 0,
    toneMatch: false,
  });
  assert.ok(rendered);
  const identity = buildIdentityPolygon(marks, width, height);
  const faceIndex = findPixel(width, height, (x, y) => pointInPolygon(x + 0.5, y + 0.5, identity) && y > 0.55 * height);
  const hairIndex = findPixel(width, height, (x, y) => y < 3);
  assert.ok(faceIndex >= 0 && hairIndex >= 0);
  assert.deepEqual(rgb(rendered.rgba, faceIndex), [200, 100, 50]);
  assert.equal(rendered.rgba[faceIndex * 4 + 3], 255);
  assert.equal(rendered.rgba[hairIndex * 4 + 3], 0, "hair stays Lucy's frame (transparent overlay)");
});

test("transformPolygon / polygonRegion: similarity maps the oval and the bbox is clamped", () => {
  const polygon = [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 40 }, { x: 10, y: 40 }];
  const shifted = transformPolygon(polygon, { scale: 1, cos: 1, sin: 0, tx: 5, ty: -20 });
  assert.deepEqual(shifted[0], { x: 15, y: -10 });
  const scaled = transformPolygon(polygon, { scale: 2, cos: 1, sin: 0, tx: 0, ty: 0 });
  assert.deepEqual(scaled[2], { x: 60, y: 80 });
  assert.deepEqual(polygonRegion(polygon, 100, 100, 3), { x: 7, y: 7, width: 26, height: 36 });
  assert.deepEqual(polygonRegion(shifted, 100, 100, 0), { x: 15, y: 0, width: 20, height: 20 });
  assert.equal(polygonRegion([{ x: 200, y: 200 }, { x: 210, y: 200 }, { x: 210, y: 210 }], 100, 100), null);
});

test("compositeSyncedFace: webcam face inside the oval, Lucy outside, Lucy hair stays on top", () => {
  const { marks, width, height } = landmarks();
  const identity = buildIdentityPolygon(marks, width, height);
  const transform = { scale: 1, cos: 1, sin: 0, tx: 0, ty: 0 };
  const polygon = transformPolygon(identity, transform);
  const region = polygonRegion(polygon, width, height, 2);
  const base = fill(region.width, region.height, [10, 20, 200]);
  // Lucy bangs: a hair band across the top rows of the region that reaches into the oval.
  const baseHair = new Uint8Array(region.width * region.height);
  const oval = polygonRegion(polygon, width, height, 0);
  const bangsRow = oval.y - region.y + 3;
  for (let x = 0; x < region.width; x++) baseHair[bangsRow * region.width + x] = 1;
  // Webcam crop covering the whole frame, a different flat color.
  const face = fill(width, height, [200, 100, 50]);
  const out = compositeSyncedFace({
    base, region, baseHair, face, faceX: 0, faceY: 0, faceWidth: width, faceHeight: height,
    transform, polygon, featherRadius: 0, toneMatch: false,
  });
  assert.ok(out && out.painted > 0);
  const alphaAt = (gx, gy) => out.rgba[((gy - region.y) * region.width + (gx - region.x)) * 4 + 3];
  const rgbAt = (gx, gy) => rgb(out.rgba, (gy - region.y) * region.width + (gx - region.x));
  const cx = width >> 1;
  const cy = Math.round(0.6 * height);
  assert.ok(pointInPolygon(cx + 0.5, cy + 0.5, identity));
  assert.equal(alphaAt(cx, cy), 255, "inside the oval the webcam face is pasted");
  assert.deepEqual(rgbAt(cx, cy), [200, 100, 50]);
  assert.equal(alphaAt(region.x, region.y), 0, "outside the oval Lucy's frame stays");
  assert.equal(alphaAt(cx, bangsRow + region.y), 0, "Lucy's bangs over the face are not covered");
  // Tone match maps the webcam tone onto Lucy's tone when enabled.
  const toned = compositeSyncedFace({
    base, region, face, faceWidth: width, faceHeight: height, transform, polygon, featherRadius: 0, toneMatch: true,
  });
  assert.ok(toned.tone.samples > 0);
});

test("compositeSyncedFace: low-frequency transfer takes Lucy's colour, keeps the webcam detail", () => {
  const { marks, width, height } = landmarks();
  const identity = buildIdentityPolygon(marks, width, height);
  const transform = { scale: 1, cos: 1, sin: 0, tx: 0, ty: 0 };
  const polygon = transformPolygon(identity, transform);
  const region = polygonRegion(polygon, width, height, 2);
  const base = fill(region.width, region.height, [10, 20, 200]);
  // Webcam face: flat colour plus a one-pixel bright detail at the oval centre.
  const face = fill(width, height, [200, 100, 50]);
  const cx = width >> 1;
  const cy = Math.round(0.6 * height);
  const detail = (cy * width + cx) * 4;
  face[detail] = 250;
  face[detail + 1] = 150;
  face[detail + 2] = 100;
  const out = compositeSyncedFace({
    base, region, face, faceWidth: width, faceHeight: height, transform, polygon,
    featherRadius: 0, blendRadius: 6, blendStrength: 1,
  });
  assert.ok(out && out.painted > 0);
  const at = (gx, gy) => rgb(out.rgba, (gy - region.y) * region.width + (gx - region.x));
  // Away from the detail the pasted face carries Lucy's colour (flat webcam → zero high frequency).
  const plain = at(cx - 4, cy + 4);
  assert.ok(Math.abs(plain[0] - 10) <= 3 && Math.abs(plain[1] - 20) <= 3 && Math.abs(plain[2] - 200) <= 3, JSON.stringify(plain));
  // At the detail the webcam's local contrast (+50) survives on top of Lucy's colour.
  const spot = at(cx, cy);
  assert.ok(spot[0] - plain[0] >= 40, `detail kept: ${spot} vs ${plain}`);
});

test("compositeSyncedFace: webcam crop offset and translation are honored", () => {
  const { marks, width, height } = landmarks();
  const identity = buildIdentityPolygon(marks, width, height);
  // Lucy's face sits 4 px right / 6 px down from the webcam's.
  const transform = { scale: 1, cos: 1, sin: 0, tx: 4, ty: 6 };
  const polygon = transformPolygon(identity, transform);
  const region = polygonRegion(polygon, width + 8, height + 8, 0);
  const base = fill(region.width, region.height, [0, 0, 0]);
  // Webcam crop is a sub-rectangle whose pixel color encodes its x coordinate.
  const crop = polygonRegion(identity, width, height, 2);
  const face = new Uint8ClampedArray(crop.width * crop.height * 4);
  for (let y = 0; y < crop.height; y++) {
    for (let x = 0; x < crop.width; x++) {
      const o = (y * crop.width + x) * 4;
      face[o] = (crop.x + x) * 4;
      face[o + 1] = (crop.y + y) * 3;
      face[o + 3] = 255;
    }
  }
  const out = compositeSyncedFace({
    base, region, face, faceX: crop.x, faceY: crop.y, faceWidth: crop.width, faceHeight: crop.height,
    transform, polygon, featherRadius: 0, toneMatch: false,
  });
  assert.ok(out);
  const gx = width >> 1;
  const gy = Math.round(0.6 * height);
  const lucyX = gx + 4;
  const lucyY = gy + 6;
  const i = (lucyY - region.y) * region.width + (lucyX - region.x);
  assert.equal(out.rgba[i * 4 + 3], 255);
  // Bilinear sample at pixel center maps back to webcam (gx, gy).
  assert.ok(Math.abs(out.rgba[i * 4] - gx * 4) <= 4, `x encodes ${out.rgba[i * 4]} vs ${gx * 4}`);
  assert.ok(Math.abs(out.rgba[i * 4 + 1] - gy * 3) <= 3, `y encodes ${out.rgba[i * 4 + 1]} vs ${gy * 3}`);

  // The same crop stored at half resolution (faceScale 0.5) lands on the same webcam pixels.
  const halfW = crop.width >> 1;
  const halfH = crop.height >> 1;
  const half = new Uint8ClampedArray(halfW * halfH * 4);
  for (let y = 0; y < halfH; y++) {
    for (let x = 0; x < halfW; x++) {
      const o = (y * halfW + x) * 4;
      half[o] = (crop.x + (x + 0.5) * 2 - 0.5) * 4;
      half[o + 1] = (crop.y + (y + 0.5) * 2 - 0.5) * 3;
      half[o + 3] = 255;
    }
  }
  const scaled = compositeSyncedFace({
    base, region, face: half, faceX: crop.x, faceY: crop.y, faceWidth: halfW, faceHeight: halfH, faceScale: 0.5,
    transform, polygon, featherRadius: 0, toneMatch: false,
  });
  assert.equal(scaled.rgba[i * 4 + 3], 255);
  assert.ok(Math.abs(scaled.rgba[i * 4] - gx * 4) <= 6, `scaled x encodes ${scaled.rgba[i * 4]} vs ${gx * 4}`);
  assert.ok(Math.abs(scaled.rgba[i * 4 + 1] - gy * 3) <= 5, `scaled y encodes ${scaled.rgba[i * 4 + 1]} vs ${gy * 3}`);
});

test("pickSyncedFrame: picks the buffered webcam frame that matches Lucy's head pose and expression", () => {
  const anchorsAt = (dx, mouth = 0.62) => {
    const { marks, width, height } = landmarks({
      leftEye: { x: 0.36 + dx, y: 0.42 },
      rightEye: { x: 0.64 + dx, y: 0.42 },
      nose: { x: 0.5 + dx, y: 0.52 },
      mouth: { x: 0.5 + dx, y: mouth },
    });
    marks[14] = { x: 0.5 + dx, y: mouth + 0.02, z: 0 };
    return { anchors: faceAnchorPoints(marks, width, height), expr: expressionFeatures(marks) };
  };
  // Head slides right over 1 s; Lucy shows the pose from 600 ms ago.
  const entries = [];
  for (let k = 0; k <= 10; k++) {
    const { anchors, expr } = anchorsAt(k * 0.02);
    entries.push({ t: 1000 + k * 100, anchors, expr });
  }
  const lucy = anchorsAt(0.08);
  const picked = pickSyncedFrame(entries, lucy.anchors, lucy.expr, 2000, NaN);
  assert.equal(picked.entry.t, 1400);
  assert.equal(picked.latencyMs, 600);
  assert.equal(picked.ambiguous, false);

  // Still head, mouth opens at t=1500: expression tells the frames apart.
  const still = [];
  for (let k = 0; k <= 10; k++) {
    const { anchors, expr } = anchorsAt(0, k >= 5 ? 0.66 : 0.62);
    still.push({ t: 1000 + k * 100, anchors, expr });
  }
  const lucyOpen = anchorsAt(0, 0.66);
  const openPick = pickSyncedFrame(still, lucyOpen.anchors, lucyOpen.expr, 2000, 700);
  assert.ok(openPick.entry.t >= 1500, "an open-mouth frame is chosen");
  // Among equal candidates the one nearest the latency estimate (target 1300) wins.
  assert.equal(openPick.entry.t, 1500);
  const closedPick = pickSyncedFrame(still, lucyOpen.anchors, lucyOpen.expr, 2000, 300);
  assert.equal(closedPick.entry.t, 1700, "latency estimate 300 ms → frame at 1700");
  assert.equal(pickSyncedFrame([], lucy.anchors, lucy.expr, 0, 0), null);
});

test("fitTone matches styled tone to the webcam tone and clamps the gain", () => {
  const n = 200;
  const person = new Uint8ClampedArray(n * 4);
  const styled = new Uint8ClampedArray(n * 4);
  const idx = [];
  for (let i = 0; i < n; i++) {
    const v = 100 + (i % 50);
    person[i * 4] = v + 20;
    person[i * 4 + 1] = v;
    person[i * 4 + 2] = v - 20;
    styled[i * 4] = v;
    styled[i * 4 + 1] = v;
    styled[i * 4 + 2] = v;
    idx.push(i);
  }
  const tone = fitTone(person, styled, idx);
  assert.equal(tone.samples, n);
  assert.ok(Math.abs(tone.gain[0] - 1) < 1e-6);
  assert.ok(Math.abs(tone.offset[0] - 20) < 1e-6);
  assert.ok(Math.abs(tone.offset[2] + 20) < 1e-6);
  const few = fitTone(person, styled, idx.slice(0, 10));
  assert.deepEqual(few.gain, [1, 1, 1]);
  assert.deepEqual(few.offset, [0, 0, 0]);
  // Flat styled input → std ≈ 0 → gain clamps at the maximum instead of exploding.
  const flat = new Uint8ClampedArray(n * 4).fill(50);
  assert.equal(fitTone(person, flat, idx).gain[0], 1.3);
});
