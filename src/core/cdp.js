/**
 * axuse — CDP transport and browser lifecycle.
 *
 * Lineage: Codex's chrome.debugger bridge (browser-level CDP with flat
 * sessions, event routing, send timeouts) and ZCode's guest debugger
 * discipline (attach → enable → use → detach, pending-command accounting).
 *
 * Node >= 22 gives us a native WebSocket client, which keeps axuse
 * dependency-free — important for a library that harnesses vendor via MCP.
 */
import { spawn } from "node:child_process";
import { accessSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { AxError, Codes } from "./errors.js";

const SEND_TIMEOUT_MS = 30_000;

function isMacBrandedChrome(executable) {
  // ALL branded Chrome channels (stable/Beta/Dev/Canary) ignore
  // --load-extension on current macOS builds — live-verified for stable and
  // Beta/Canary (Edge Beta honors it; CfT/Chromium do too).
  return process.platform === "darwin"
    && /(?:^|\/)Google Chrome(?: Beta| Dev| Canary)?\.app\/Contents\/MacOS\/Google Chrome(?: Beta| Dev| Canary)?$/.test(executable);
}

/** Candidate Chromium-family executables, best first. */
export function browserCandidates({ extensionCapable = false, browser, ignoreEnv = false, exact = false } = {}) {
  const out = [];
  if (!ignoreEnv && process.env.AXUSE_BROWSER && process.env.AXUSE_BROWSER.trim()) {
    const configured = process.env.AXUSE_BROWSER.trim();
    // Current macOS branded Chrome builds silently ignore --load-extension.
    // Do not let a general AXUSE_BROWSER override defeat the explicit
    // extension-capable selection used by the bridge test/setup lane.
    if (!(extensionCapable && isMacBrandedChrome(configured))) {
      out.push(configured);
      return out;
    }
  }
  if (process.platform === "win32") {
    const chrome = [];
    const edge = [];
    for (const envVar of ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]) {
      const base = process.env[envVar];
      if (!base) continue;
      chrome.push(join(base, "Google", "Chrome", "Application", "chrome.exe"));
    }
    for (const envVar of ["ProgramFiles", "ProgramFiles(x86)"]) {
      const base = process.env[envVar];
      if (!base) continue;
      edge.push(join(base, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
    out.push(...(browser === "edge" ? edge : browser === "chrome" ? chrome : [...chrome, ...edge]));
  } else if (process.platform === "darwin") {
    const app = (name, executable) => [
      `/Applications/${name}.app/Contents/MacOS/${executable}`,
      join(homedir(), "Applications", `${name}.app`, "Contents", "MacOS", executable),
    ];
    const chrome = app("Google Chrome", "Google Chrome");
    const cft = app("Google Chrome for Testing", "Google Chrome for Testing");
    const chromium = app("Chromium", "Chromium");
    const edge = app("Microsoft Edge", "Microsoft Edge");
    // Preview/beta channels — test-matrix coverage, best-effort ordering.
    // NOTE: branded Chrome Beta/Canary ignore --load-extension like stable
    // branded Chrome (live-verified); Edge Beta honors it. Only Edge Beta
    // joins the extension-capable lane.
    const chromeBeta = app("Google Chrome Beta", "Google Chrome Beta");
    const chromeCanary = app("Google Chrome Canary", "Google Chrome Canary");
    const edgeBeta = app("Microsoft Edge Beta", "Microsoft Edge Beta");
    const preview = [...chromeBeta, ...chromeCanary, ...edgeBeta];
    // Branded Chrome (any channel) intentionally stays out of the automated
    // extension lane: current macOS builds silently ignore --load-extension.
    // Users can still load the unpacked bridge manually in branded Chrome.
    if (extensionCapable) {
      const preferred = browser === "edge" ? edge
        : browser === "edge-beta" ? edgeBeta
          : browser === "chromium" ? chromium
            : browser === "chrome-for-testing" ? cft
              : [...edge, ...edgeBeta, ...chromium, ...cft];
      out.push(...preferred);
      for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
        if (!browser || browser === "chromium") out.push(join(dir, "chromium"));
        if (!browser || browser === "chrome-for-testing") out.push(join(dir, "google-chrome-for-testing"));
      }
    } else if (browser === "edge") {
      out.push(...edge);
    } else if (browser === "edge-beta") {
      out.push(...edgeBeta);
    } else if (browser === "chromium") {
      out.push(...chromium);
    } else if (browser === "chrome-for-testing") {
      out.push(...cft);
    } else if (browser === "chrome-beta") {
      out.push(...chromeBeta);
    } else if (browser === "chrome-canary") {
      out.push(...chromeCanary);
    } else if (browser === "chrome") {
      out.push(...(exact ? chrome : [...chrome, ...cft, ...preview, ...chromium, ...edge]));
    } else {
      out.push(...chrome, ...cft, ...preview, ...chromium, ...edge);
    }
  } else {
    const chrome = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
    ];
    const chromium = ["/usr/bin/chromium", "/usr/bin/chromium-browser"];
    const cft = ["/usr/bin/google-chrome-for-testing", "/usr/bin/chrome-for-testing"];
    const edge = ["/usr/bin/microsoft-edge"];
    const chromeBeta = ["/usr/bin/google-chrome-beta"];
    out.push(...(browser === "edge" ? edge
      : browser === "chromium" ? chromium
        : browser === "chrome-for-testing" ? cft
          : browser === "chrome-beta" ? chromeBeta
            : browser === "chrome" ? (exact ? chrome : [...chrome, ...cft, ...chromeBeta, ...chromium, ...edge])
              : [...chrome, ...cft, ...chromeBeta, ...chromium, ...edge]));
  }
  return [...new Set(out)];
}

/** Probe candidates, return the first that exists, or null. */
export function locateBrowser(options = {}) {
  for (const c of browserCandidates(options)) {
    try {
      accessSync(c);
      return c;
    } catch {}
  }
  return null;
}

/** A single browser-level WebSocket connection with flat session routing. */
export class CdpConnection {
  /** @param {string} wsUrl */
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map(); // id → {resolve, reject, timer}
    this.eventHandlers = new Set(); // (msg) => void
    this.closed = false;
  }

  async connect() {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new AxError(Codes.ATTACH_FAILED, `CDP WebSocket handshake timed out: ${this.wsUrl}`)),
        10_000,
      );
      ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(t);
        reject(new AxError(Codes.ATTACH_FAILED,
          `CDP WebSocket handshake failed: ${this.wsUrl}. If attaching to a Chrome you started yourself, relaunch it with --remote-allow-origins=* and --remote-debugging-port=<port>.`,
          { retry: "never" }));
      }, { once: true });
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new AxError(Codes.INTERNAL, `CDP ${msg.error.code ?? ""} ${msg.error.message}`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.eventHandlers) {
          try { h(msg); } catch {}
        }
      }
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new AxError(Codes.ATTACH_FAILED, "CDP connection closed"));
      }
      this.pending.clear();
    });
  }

  onEvent(handler) {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /**
   * Send a CDP command. `sessionId` routes to a flattened target session.
   * Mirrors Codex's `tab_cdp_call` semantics (generic passthrough + timeout).
   */
  send(method, params = {}, sessionId) {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new AxError(Codes.ATTACH_FAILED, "CDP connection is not open"));
    }
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AxError(Codes.TIMEOUT, `CDP ${method} timed out after ${SEND_TIMEOUT_MS}ms`, { retry: "retry" }));
      }, SEND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(msg));
    });
  }

  close() {
    this.closed = true;
    try { this.ws.close(); } catch {}
  }
}

/** One controlled browser (launched by us, or attached to an existing one). */
export class BrowserHandle {
  constructor() {
    this.conn = null;
    this.proc = null; // child process when we launched it
    this.userDataDir = null;
    this.ephemeral = true; // false: a persistent A2 profile — never deleted
    this.launched = false;
    this.tabs = new Map(); // tab_id → session bookkeeping (owned by controller)
  }

  /** Launch a fresh Chromium with an ephemeral profile. Headed by default so
   *  a human can watch the agent work (the Codex/ZCode "visible browser"
   *  philosophy); headless is opt-in for servers and tests.
   *  `userDataDir` (plugin prerequisite A2, session-vault): reuse a PERSISTENT
   *  profile — not deleted on dispose, only swept by nobody but the owner. */
  static async launch({ executablePath, headless = false, extraArgs = [], userDataDir, profileRoot: profileRootOverride } = {}) {
    const exe = executablePath || locateBrowser();
    if (!exe) {
      throw new AxError(Codes.LAUNCH_FAILED,
        "No Chromium-family browser found. axuse needs Google Chrome or Microsoft Edge: tell the user to install Chrome from https://www.google.com/chrome/ and try again. (Developers: set AXUSE_BROWSER=/path/to/chrome or pass executable_path.)",
        { retry: "never" });
    }
    // Cold starts vary by OS and host: a fresh macOS .app can spend >15 s in
    // first-run work (signature verification, updates) before DevTools comes
    // up. The default accommodates that; AXUSE_LAUNCH_TIMEOUT_MS overrides.
    const launchTimeoutMs = Number(process.env.AXUSE_LAUNCH_TIMEOUT_MS ?? 30_000);
    const persistent = typeof userDataDir === "string" && userDataDir.trim().length > 0;
    const profileRoot = profileRootOverride || process.env.AXUSE_PROFILE_DIR || tmpdir();
    try { mkdirSync(profileRoot, { recursive: true }); } catch {}
    sweepStaleProfiles(profileRoot);
    const dir = persistent ? userDataDir : mkdtempSync(join(profileRoot, "axuse-profile-"));
    const args = [
      `--user-data-dir=${dir}`,
      "--remote-debugging-port=0", // ephemeral port, parsed from stderr
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-smooth-scrolling", // wheel input lands instantly: no in-flight scroll when clicking
      "--remote-allow-origins=*", // modern Chrome rejects unknown ws Origins
    ];
    if (headless) args.push("--headless");
    args.push(...extraArgs);
    const proc = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
    let wsUrl;
    try {
      wsUrl = await new Promise((resolve, reject) => {
        let buf = "";
        let settled = false;
        const timer = setTimeout(() => {
          try { proc.kill(); } catch {}
          if (!settled) {
            settled = true;
            reject(new AxError(Codes.LAUNCH_FAILED,
              `Timed out after ${launchTimeoutMs}ms waiting for the DevTools WebSocket URL (first launch of a browser can be slow; raise AXUSE_LAUNCH_TIMEOUT_MS if this recurs)`,
              { retry: "retry" }));
          }
        }, launchTimeoutMs);
        const onData = (d) => {
          buf += String(d);
          const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
          if (m) {
            settled = true;
            clearTimeout(timer);
            resolve(m[1]);
          }
        };
        proc.stderr.on("data", onData);
        proc.stdout.on("data", onData);
        proc.on("error", (e) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          reject(new AxError(Codes.LAUNCH_FAILED, `Could not start browser: ${e.message}`, { retry: "never" }));
        });
        proc.on("exit", (code) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          reject(new AxError(Codes.LAUNCH_FAILED, `Browser exited during startup (code ${code})`, { retry: "retry" }));
        });
      });
    } catch (e) {
      try { proc.kill(); } catch {}
      if (!persistent) await removeDirWithRetry(dir);
      throw e;
    }
    const h = new BrowserHandle();
    h.proc = proc;
    h.userDataDir = dir;
    h.ephemeral = !persistent; // persistent (A2) profiles are never deleted on dispose
    h.launched = true;
    h.conn = new CdpConnection(wsUrl);
    try {
      await h.conn.connect();
    } catch (e) {
      await h.dispose();
      throw e;
    }
    return h;
  }

  /** Attach to an already-running browser (user's real Chrome with its real
   *  logged-in sessions — the Codex "runs in the user's session" pattern). */
  static async attach(cdpUrl) {
    let wsUrl = cdpUrl;
    if (!wsUrl.startsWith("ws://")) {
      // Assume an http endpoint like http://127.0.0.1:9222
      const base = cdpUrl.replace(/\/$/, "");
      const res = await fetch(`${base}/json/version`);
      if (!res.ok) throw new AxError(Codes.ATTACH_FAILED, `Cannot reach ${base}/json/version`);
      const info = await res.json();
      wsUrl = info.webSocketDebuggerUrl;
      if (!wsUrl) throw new AxError(Codes.ATTACH_FAILED, "Target exposes no webSocketDebuggerUrl");
    }
    const h = new BrowserHandle();
    h.conn = new CdpConnection(wsUrl);
    await h.conn.connect();
    return h;
  }

  async createTab(url = "about:blank", { autoAttach = true } = {}) {
    const { targetId } = await this.conn.send("Target.createTarget", { url });
    return this.attachTab(targetId, { autoAttach });
  }

  /** Attach to an existing page target (e.g. a popup / target=_blank tab). */
  async attachTab(targetId, { autoAttach = true } = {}) {
    const { sessionId } = await this.conn.send("Target.attachToTarget", { targetId, flatten: true });
    // Enable the domains our event ring buffer records.
    await this.conn.send("Page.enable", {}, sessionId);
    await this.conn.send("Runtime.enable", {}, sessionId);
    await this.conn.send("Log.enable", {}, sessionId);
    // File inputs: intercept the native chooser (it would block forever) and
    // let ax_upload answer it with DOM.setFileInputFiles.
    try { await this.conn.send("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId); } catch {}
    // OOPIF support (Codex/ZCode merge frames into the snapshot): child
    // iframe targets auto-attach as flat sessions; Target.attachedToTarget
    // events arrive tagged with this tab's sessionId. Not available through
    // the chrome.debugger extension bridge (no Target domain there) — that
    // backend degrades to listed-but-not-entered frames.
    if (autoAttach) {
      await this.conn.send("Target.setAutoAttach",
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
    }
    return { targetId, sessionId };
  }

  async closeTabTarget(targetId) {
    try { await this.conn.send("Target.closeTarget", { targetId }); } catch {}
  }

  /** Close the connection, stop a launched browser, and delete its
   *  ephemeral profile once Chrome has released the files. Persistent
   *  profiles (A2: session-vault, aged profiles) are left on disk — the
   *  owner (the vault) manages their lifecycle. */
  async dispose() {
    try { this.conn.close(); } catch {}
    const proc = this.proc;
    if (proc && proc.exitCode === null) {
      const exited = new Promise((ok) => proc.once("exit", ok));
      try { proc.kill(); } catch {}
      await Promise.race([exited, new Promise((ok) => setTimeout(ok, 3000))]);
    }
    if (this.userDataDir && this.ephemeral) await removeDirWithRetry(this.userDataDir);
  }
}

/** Chrome's helper processes can hold profile files briefly after exit. */
async function removeDirWithRetry(dir, attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return true; } catch {}
    await new Promise((ok) => setTimeout(ok, 200 * (i + 1)));
  }
  return false;
}

/** Best-effort GC of profiles leaked by crashed/killed runs (older than 1h;
 *  a profile still in use is locked by Chrome and simply fails to delete). */
function sweepStaleProfiles(root, maxAgeMs = 3_600_000) {
  let names;
  try { names = readdirSync(root); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith("axuse-profile-")) continue;
    const dir = join(root, name);
    try {
      if (now - statSync(dir).mtimeMs > maxAgeMs) rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}
