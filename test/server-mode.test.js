/**
 * Server mode — the display-less-Linux-host lane: headed Chrome on an
 * auto-booted private Xvfb (never --headless, which challenge/anti-bot pages
 * detect as their first step).
 *
 * Two lanes:
 *  - unit (always): pure decision seams — size parsing, DISPLAY parsing +
 *    dead-display detection, the launch decision matrix, display-number
 *    picking, env parsing, the no-sandbox decision.
 *  - live (Linux + Xvfb + a browser): the REAL lane end-to-end with a dead
 *    DISPLAY forced in-process — server mode must boot a private Xvfb,
 *    launch Chrome fully headed on it, and expose an anti-bot posture
 *    (no Headless UA, navigator.webdriver false, desktop viewport, WebGL).
 *    The live tests are hermetic: they force a dead DISPLAY value and boot
 *    their own Xvfb; they never touch the operator's session display.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  parseDisplaySize, displayNumber, displayUsable, displayGeometry,
  serverModeEnabled, serverModePlan, pickDisplayNumber, takenDisplayNumbers,
  needsNoSandbox, virtualDisplayStatus, __resetVirtualDisplay,
} from "../src/core/vdisplay.js";
import { locateBrowser } from "../src/core/cdp.js";
import { Controller } from "../src/core/controller.js";

/* ------------------------------------------------------------ unit lane */

test("server mode: display-size parsing accepts only sane geometries", () => {
  assert.deepEqual(parseDisplaySize("1920x1080x24"), { w: 1920, h: 1080, d: 24 });
  assert.deepEqual(parseDisplaySize("1366x768"), { w: 1366, h: 768, d: 24 });
  assert.equal(parseDisplaySize("8000x600"), null); // width over cap
  assert.equal(parseDisplaySize("320x240"), null); // under floor
  assert.equal(parseDisplaySize("1920"), null);
  assert.equal(parseDisplaySize("1920x1080x8"), null); // bad depth
  assert.equal(parseDisplaySize(""), null);
  assert.equal(parseDisplaySize(null), null);
  // geometry falls back to the default when AXUSE_DISPLAY_SIZE is garbage
  assert.deepEqual(displayGeometry({}), { w: 1920, h: 1080, d: 24 });
  assert.deepEqual(displayGeometry({ AXUSE_DISPLAY_SIZE: "1280x720x32" }), { w: 1280, h: 720, d: 32 });
});

test("server mode: DISPLAY parsing and dead-display detection", () => {
  assert.equal(displayNumber(":1"), 1);
  assert.equal(displayNumber(":1.0"), 1);
  assert.equal(displayNumber("localhost:10.0"), 10);
  assert.equal(displayNumber("unix:0"), 0);
  assert.equal(displayNumber(""), null);
  assert.equal(displayNumber(null), null);
  assert.equal(displayNumber("garbage"), null);
  // A dead DISPLAY counts as absent — that is what makes the fallback safe
  // on hosts that carry a stale value (closed SSH forward, dead CI :99).
  assert.equal(displayUsable(":65530"), false); // no such X socket, ever
  // Injectable exists seam: a "socket" for :42 → usable
  assert.equal(displayUsable(":42", { exists: (p) => /\/X42$/.test(p) }), true);
  assert.equal(displayUsable(":43", { exists: (p) => /\/X42$/.test(p) }), false);
});

test("server mode: the launch decision matrix is pure and typed", () => {
  const base = { platform: "linux", headless: false, display: "", usable: false, xvfb: true, enabled: true };
  assert.equal(serverModePlan({ ...base }).action, "boot");
  // not linux / headless / live display → no server mode involvement
  assert.equal(serverModePlan({ ...base, platform: "win32" }).action, "native");
  assert.equal(serverModePlan({ ...base, headless: true }).action, "skip");
  assert.equal(serverModePlan({ ...base, usable: true }).action, "native");
  // dead display + disabled → typed hint naming AXUSE_SERVER_MODE
  const off = serverModePlan({ ...base, enabled: false });
  assert.equal(off.action, "fail-disabled");
  assert.match(off.hint, /AXUSE_SERVER_MODE/);
  // dead display + no Xvfb → typed install hint
  const noX = serverModePlan({ ...base, xvfb: false });
  assert.equal(noX.action, "fail-xvfb");
  assert.match(noX.hint, /apt-get install -y xvfb/);
  assert.match(noX.hint, /detect --headless/);
});

test("server mode: free display numbers are picked away from taken ones", () => {
  const taken = takenDisplayNumbers();
  assert.ok(taken.includes(0) && taken.includes(1), "native session displays are never taken");
  // Deterministic draws: 20 (busy), 21 (busy), then a free one.
  let i = 0;
  const seq = () => [0, 1 / 978, 0.5][i++];
  const n1 = pickDisplayNumber({ taken: [20, 21], random: seq });
  assert.ok(![20, 21].includes(n1) && n1 >= 20 && n1 <= 997, `picked a free number, got ${n1}`);
  const n2 = pickDisplayNumber({ taken: [], random: () => 0.5 });
  assert.ok(n2 >= 20 && n2 <= 997);
  // taken: everything in the range → falls back above 1000 instead of failing
  const busy = Array.from({ length: 978 }, (_, k) => 20 + k);
  assert.ok(pickDisplayNumber({ taken: busy, random: () => 0 }) >= 1000);
});

test("server mode: AXUSE_SERVER_MODE / no-sandbox env parsing", () => {
  for (const v of ["", "auto", "1", "true", "on", undefined]) {
    assert.equal(serverModeEnabled({ AXUSE_SERVER_MODE: v }), true, `enabled: ${v}`);
  }
  for (const v of ["0", "off", "false", "no"]) {
    assert.equal(serverModeEnabled({ AXUSE_SERVER_MODE: v }), false, `disabled: ${v}`);
  }
  // no-sandbox: explicit env beats everything; root forces it; otherwise off
  assert.deepEqual(needsNoSandbox({ uid: 1000, env: { AXUSE_NO_SANDBOX: "1" } }), { add: true, reason: "AXUSE_NO_SANDBOX=1" });
  assert.equal(needsNoSandbox({ uid: 0, env: {} }).add, true);
  assert.match(needsNoSandbox({ uid: 0, env: {} }).reason, /root/);
  assert.equal(needsNoSandbox({ uid: 1000, env: {} }).add, false);
});

/* ------------------------------------------------------------ live lane */

const linux = process.platform === "linux";
const xvfb = spawnSync("which", ["Xvfb"]).status === 0;
const hasBrowser = !!locateBrowser();
const liveGate = linux && xvfb && hasBrowser;
const liveSkip = liveGate ? false
  : "requires Linux + Xvfb + a Chromium-family browser (sudo apt install xvfb; server mode is the display-less Linux lane)";
const DEAD_DISPLAY = ":988"; // the suite's own dead value (desktop lane uses :977-:980)

/** Force the in-process dead-display world; restores afterwards. */
function withDeadDisplay() {
  const savedDisplay = process.env.DISPLAY;
  const savedMode = process.env.AXUSE_SERVER_MODE;
  process.env.DISPLAY = DEAD_DISPLAY;
  process.env.AXUSE_SERVER_MODE = undefined;
  return () => {
    if (savedDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = savedDisplay;
    if (savedMode === undefined) delete process.env.AXUSE_SERVER_MODE;
    else process.env.AXUSE_SERVER_MODE = savedMode;
    __resetVirtualDisplay();
  };
}

test("server mode: stays off when disabled (typed failure, no Xvfb boot)", { skip: liveSkip }, async (t) => {
  const restore = withDeadDisplay();
  t.after(restore);
  process.env.AXUSE_SERVER_MODE = "0";
  const c = new Controller();
  t.after(() => c.dispose());
  await assert.rejects(
    () => c.execute("open", { url: "about:blank", settle_ms: 100 }),
    (e) => e.code === "LAUNCH_FAILED" && /AXUSE_SERVER_MODE/.test(e.message) && e.retry === "never",
  );
  assert.equal(virtualDisplayStatus().active, false, "disabled server mode never boots an Xvfb");
});

test("server mode: headed Chrome auto-boots a virtual display (anti-bot posture)", { skip: liveSkip }, async (t) => {
  const restore = withDeadDisplay();
  t.after(restore);
  const c = new Controller();
  t.after(() => c.dispose());
  const geo = displayGeometry();

  const r = await c.execute("open", {
    url: "data:text/html,<h1>server mode</h1><button id=\"b\" onclick=\"this.textContent='clicked'\">go</button>",
    settle_ms: 150,
  });
  // The fact the model sees: headed on an auto-booted virtual display.
  assert.equal(r.display?.virtual, true);
  assert.match(r.display.id, /^:\d+$/);
  assert.equal(r.display.width, geo.w);
  assert.equal(r.display.height, geo.h);

  // Anti-bot posture, measured in the real browser — the whole point of the
  // lane: a genuine headed build, no headless fingerprint anywhere.
  const ua = JSON.parse((await c.execute("evaluate", { expression: "navigator.userAgent" })).value ?? '""');
  const fp = JSON.parse((await c.execute("evaluate", {
    expression: "({ webdriver: navigator.webdriver, w: innerWidth, h: innerHeight, webgl: !!document.createElement('canvas').getContext('webgl') })",
  })).value ?? "{}");
  assert.doesNotMatch(ua, /headless/i);
  assert.equal(fp.webdriver, false);
  assert.ok(fp.w >= geo.w - 80, `viewport width ${fp.w} ≈ ${geo.w} (--window-size honored)`);
  assert.equal(fp.webgl, true, "WebGL present (SwiftShader) — a signal anti-bot checks");

  // Pixels work too (challenge solvers vision-crop from screenshots).
  const shot = await c.execute("screenshot", { budget_bytes: 60_000 });
  assert.ok(shot.image.bytes > 2000, "a real rendered frame, not a black void");
  assert.ok(shot.image.base64.startsWith("/9j/"), "JPEG SOI");

  // The virtual display is a singleton: a second launch reuses it.
  const r2 = await c.execute("open", { url: "about:blank", settle_ms: 100 });
  assert.equal(r2.display?.id, r.display.id);

  // And the trusted-input path works on it (the solver lane's primitives).
  const clicked = await c.execute("click", { target: { x: 8, y: 8 }, settle_ms: 50 });
  assert.ok(clicked, "input dispatch on the virtual display is fine");
});

test("server mode: AXUSE_HEADLESS=1 lane still opens headless on a dead display", { skip: liveSkip }, async (t) => {
  const restore = withDeadDisplay();
  t.after(restore);
  const savedHeadless = process.env.AXUSE_HEADLESS;
  process.env.AXUSE_HEADLESS = "1";
  t.after(() => { if (savedHeadless === undefined) delete process.env.AXUSE_HEADLESS; else process.env.AXUSE_HEADLESS = savedHeadless; });
  __resetVirtualDisplay();
  const c = new Controller();
  t.after(() => c.dispose());
  const r = await c.execute("open", { url: "about:blank", settle_ms: 100 });
  assert.equal(r.display, undefined, "headless launches never report a virtual display");
  assert.equal(virtualDisplayStatus().active, false, "headless needs no display — none was booted");
});
