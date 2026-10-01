import { auth, drive } from "@googleapis/drive";
import { Readable } from "node:stream";

export class GoogleStore {
  constructor(env = process.env, clients) {
    this.folderId = env.GOOGLE_DRIVE_FOLDER_ID;
    this.clients = clients;
    this.pendingImages = new Map();
  }
  getClients() {
    if (!this.folderId) throw new Error("GOOGLE_NOT_CONFIGURED");
    if (this.clients) return this.clients;
    const driveAuth = new auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/drive"] });
    this.clients = { drive: drive({ version: "v3", auth: driveAuth }) };
    return this.clients;
  }
  async assertPrivateFolder() {
    const { drive } = this.getClients();
    const { data } = await drive.files.get({ fileId: this.folderId, supportsAllDrives: true, fields: "id,mimeType,driveId,trashed,capabilities(canAddChildren)" });
    if (data.mimeType !== "application/vnd.google-apps.folder" || !data.driveId || data.trashed || !data.capabilities?.canAddChildren) throw new Error("PRIVATE_SHARED_FOLDER_REQUIRED");
    let pageToken;
    do {
      const { data: permissions } = await drive.permissions.list({ fileId: this.folderId, supportsAllDrives: true, fields: "nextPageToken,permissions(type)", pageToken });
      if ((permissions.permissions || []).some((p) => p.type === "anyone" || p.type === "domain")) throw new Error("FOLDER_MUST_BE_PRIVATE");
      pageToken = permissions.nextPageToken;
    } while (pageToken);
  }
  async saveLead(lead, sessionId) {
    await this.assertPrivateFolder();
    const cached = this.pendingImages.get(sessionId);
    if (cached?.id) return { imageFileId: cached.id };
    if (!cached?.promise) {
      const { drive } = this.getClients();
      const promise = drive.files.create({
        supportsAllDrives: true,
        requestBody: { name: `${sessionId}.webp`, mimeType: "image/webp", parents: [this.folderId] },
        media: { mimeType: "image/webp", body: Readable.from(lead.image) },
        fields: "id",
      }).then(({ data }) => data.id);
      this.pendingImages.set(sessionId, { promise });
    }
    try {
      const id = await this.pendingImages.get(sessionId).promise;
      this.pendingImages.set(sessionId, { id });
      return { imageFileId: id };
    } catch (error) {
      this.pendingImages.delete(sessionId);
      throw error;
    }
  }
}
