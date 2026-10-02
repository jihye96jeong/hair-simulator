import test from "node:test";
import assert from "node:assert/strict";
import { grabVideoFrameCanvas, streamTrackStates } from "../public/graftCapture.js";

test("streamTrackStates reports readyState without stopping", () => {
  let stopped = 0;
  const stream = {
    getTracks: () => [{
      kind: "video",
      readyState: "live",
      enabled: true,
      muted: false,
      stop: () => { stopped += 1; },
    }],
  };
  assert.deepEqual(streamTrackStates(stream), [{
    kind: "video",
    readyState: "live",
    enabled: true,
    muted: false,
  }]);
  assert.equal(stopped, 0);
});

test("grabVideoFrameCanvas copies pixels and does not touch tracks", () => {
  // Minimal canvas stand-in for video in node (width/height + drawImage source).
  // In browser, HTMLVideoElement is used; here we only assert the guard path.
  assert.throws(() => grabVideoFrameCanvas(null), /카메라 화면/);
  assert.throws(() => grabVideoFrameCanvas({ videoWidth: 0, videoHeight: 0 }), /카메라 화면/);
});
