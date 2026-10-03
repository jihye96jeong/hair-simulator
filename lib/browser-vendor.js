import express from "express";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Native ES modules + import map: no app build or third-party CDN required.
// retry is the SDK's one CommonJS dependency; wrap its two installed files as ESM.
export async function mountBrowserVendor(app) {
  const root = new URL("../node_modules/", import.meta.url);
  const [operation, retry, visionClassic] = await Promise.all([
    readFile(new URL("retry/lib/retry_operation.js", root), "utf8"),
    readFile(new URL("retry/lib/retry.js", root), "utf8"),
    readFile(new URL("@mediapipe/tasks-vision/vision_bundle.cjs", root), "utf8"),
  ]);
  const wrapper = (source, imports = "") => `${imports}\nconst module = { exports: {} }; const exports = module.exports;\n${source}\nexport default module.exports;`;
  app.get("/vendor/retry-operation.js", (_req, res) => res.type("js").send(wrapper(operation)));
  app.get("/vendor/retry.js", (_req, res) => res.type("js").send(wrapper(retry.replace("var RetryOperation = require('./retry_operation');", ""), 'import RetryOperation from "/vendor/retry-operation.js";')));
  // MediaPipe inside a classic worker (its wasm loader uses importScripts, which module workers lack).
  // The CommonJS bundle is exposed as a plain script that leaves its exports on `self.MediaPipeVision`.
  app.get("/vendor/mediapipe/vision_bundle.classic.js", (_req, res) => res.type("js").send(
    `(function(){var module={exports:{}};var exports=module.exports;\n${visionClassic}\nself.MediaPipeVision=module.exports;})();`,
  ));
  for (const [url, dir] of [
    ["sdk", "@decartai/sdk/dist"], ["zod", "zod"], ["mitt", "mitt/dist"],
    ["p-retry", "p-retry"], ["is-network-error", "is-network-error"],
    ["livekit", "livekit-client/dist"], ["jose", "jose/dist/webapi"],
    ["mediapipe", "@mediapipe/tasks-vision"],
  ]) app.use(`/vendor/${url}`, express.static(fileURLToPath(new URL(dir, root)), { index: false, dotfiles: "deny" }));
}
