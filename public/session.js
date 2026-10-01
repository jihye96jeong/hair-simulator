import { CAP_SECONDS } from "./shared.js";

export class RealtimeSession {
  constructor({ mode, anchor, combo, onState = () => {}, onTick = () => {}, onStop = () => {}, onRemote = () => {}, onError = () => {}, report = () => {}, now = () => performance.now(), timers = globalThis, logger = console }) {
    Object.assign(this, { mode, anchor, combo, onState, onTick, onStop, onRemote, onError, report, now, timers, logger });
    this.stopped = false;
    this.state = "connecting";
    this.billedSeconds = 0;
    this.lastTick = null;
    this.tickOffset = 0;
    this.switches = 0;
    this.captured = false;
    this.startedAt = null;
    this.sessionId = null;
    this.reported = false;
  }
  async start(stream, tokenRequest, connect, options) {
    this.stream = stream;
    try {
      const result = await tokenRequest();
      this.sessionId = result.sessionId;
      if (this.stopped) { this.sendReport(); return; }
      this.startedAt = this.now();
      this.fallback = this.timers.setTimeout(() => this.stop("cap"), (CAP_SECONDS + 5) * 1000);
      this.clock = this.timers.setInterval(() => this.onTick(this.billedSeconds, this.wallSeconds()), 250);
      const rt = await connect(stream, {
        ...options,
        onRemoteStream: (remote) => { if (!this.stopped) this.onRemote(remote); },
        onConnectionChange: (state) => this.connectionChange(state),
      }, result.token);
      // SDK connect has no AbortSignal. Dispose a late result before using it.
      if (this.stopped) { rt.disconnect(); return; }
      this.rt = rt;
      rt.on("connectionChange", (state) => this.connectionChange(state));
      rt.on("generationTick", ({ seconds }) => this.tick(seconds));
      rt.on("generationEnded", ({ seconds }) => this.tick(seconds));
      rt.on("sessionEnded", () => this.stop(this.billedSeconds >= CAP_SECONDS ? "cap" : "disconnected"));
      rt.on("error", () => { if (!this.stopped) { this.onError("실시간 연결에 문제가 생겼어요. 다시 시도해 주세요."); this.stop("error"); } });
      this.connectionChange(rt.getConnectionState());
    } catch (error) {
      if (this.stopped) return;
      this.onError(error?.publicMessage || "연결하지 못했어요. 카메라와 네트워크를 확인해 주세요.");
      this.stop("error");
    }
  }
  wallSeconds() { return this.startedAt === null ? 0 : Math.max(0, (this.now() - this.startedAt) / 1000); }
  connectionChange(state) {
    if (this.stopped) return;
    this.state = state;
    this.onState(state);
    if (state === "disconnected") this.stop("disconnected");
  }
  tick(seconds) {
    if (this.stopped || !Number.isFinite(seconds) || seconds < 0) return;
    // Preserve total usage if the provider's tick counter resets on reconnect.
    if (this.lastTick !== null && seconds < this.lastTick) {
      this.tickOffset += this.lastTick;
      this.logger.info("generationTick reset", { previousSeconds: this.lastTick, seconds, state: this.state });
    }
    this.lastTick = seconds;
    this.billedSeconds = this.tickOffset + seconds;
    this.logger.info("generationTick", { seconds, billedSeconds: this.billedSeconds, state: this.state });
    this.onTick(this.billedSeconds, this.wallSeconds());
    if (this.billedSeconds >= CAP_SECONDS) this.stop("cap");
  }
  async select(key, state) {
    if (this.stopped || !this.rt || !["connected", "generating"].includes(this.state) || this.setting) return false;
    if (key === this.combo) return true;
    this.setting = true;
    try {
      await this.rt.set(state);
      if (this.stopped) return false;
      this.combo = key;
      this.switches++;
      return true;
    } finally { this.setting = false; }
  }
  stop(reason, captured = this.captured) {
    if (this.stopped) return;
    this.stopped = true;
    this.captured = captured;
    this.timers.clearTimeout(this.fallback);
    this.timers.clearInterval(this.clock);
    const rt = this.rt;
    this.rt = null;
    try { rt?.disconnect(); } catch { this.logger.error("disconnect 실패"); }
    for (const track of this.stream?.getTracks() || []) track.stop();
    this.state = "disconnected";
    this.summary = { reason, billedSeconds: this.billedSeconds, wallSeconds: Number(this.wallSeconds().toFixed(3)), switches: this.switches, mode: this.mode, anchor: this.anchor, combo: this.combo, captured: this.captured };
    this.logger.info("session-end", this.summary);
    this.sendReport();
    this.onStop(this.summary);
  }
  sendReport() {
    if (this.reported || !this.sessionId || !this.summary) return;
    this.reported = true;
    this.report({ ...this.summary, sessionId: this.sessionId });
  }
}
