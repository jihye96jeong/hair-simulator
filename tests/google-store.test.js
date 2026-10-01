import test from "node:test";
import assert from "node:assert/strict";
import { GoogleStore } from "../lib/google-store.js";

function fixture({ publicFolder = false } = {}) {
  const calls = [];
  const drive = {
    files: {
      get: async () => ({ data: { mimeType: "application/vnd.google-apps.folder", driveId: "shared", capabilities: { canAddChildren: true } } }),
      create: async (input) => { calls.push(["upload", input]); return { data: { id: "private-file-id" } }; },
    },
    permissions: { list: async () => ({ data: { permissions: publicFolder ? [{ type: "anyone" }] : [{ type: "user" }] } }) },
  };
  const store = new GoogleStore({ GOOGLE_DRIVE_FOLDER_ID: "folder" }, { drive });
  return { calls, store };
}
const lead = { name: "=UNTRUSTED()", phone: "01012345678", region: "서울", area: "hairline", density: "1k", action: "save", consentAt: "2026-10-01T06:00:00Z", thirdPartyConsentAt: "", image: Buffer.from("image") };

test("Google stores private image on shared drive without public link", async () => {
  const f = fixture();
  assert.equal((await f.store.saveLead(lead, "session")).imageFileId, "private-file-id");
  const upload = f.calls.find(([name]) => name === "upload")[1];
  assert.deepEqual(upload.requestBody.parents, ["folder"]);
  assert.equal(upload.supportsAllDrives, true);
  assert.equal(upload.requestBody.name, "session.webp");
  assert.equal(upload.media.mimeType, "image/webp");
});
test("Drive-only client initializes without credential environment variables", () => {
  const store = new GoogleStore({ GOOGLE_DRIVE_FOLDER_ID: "folder" });
  assert.equal(typeof store.getClients().drive.files.create, "function");
});
test("public or domain-shared image folders are rejected before upload", async () => {
  const f = fixture({ publicFolder: true });
  await assert.rejects(f.store.saveLead(lead, "session"));
  assert.equal(f.calls.length, 0);
});
test("concurrent lead retries reuse the in-flight upload", async () => {
  const f = fixture();
  await Promise.all([f.store.saveLead(lead, "session"), f.store.saveLead(lead, "session")]);
  assert.equal(f.calls.filter(([name]) => name === "upload").length, 1);
});
