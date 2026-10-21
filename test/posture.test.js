/**
 * Posture audit — the productized form of every posture claim, plus the
 * governance caps that keep massive-ops processes from OOM-killing the box.
 *
 *  - unit (always): judgePosture is pure — every verdict path (pass/warn/
 *    fail, persona matches and mismatches, egress geo vs clock) is pinned.
 *  - live (browser): `axuse posture` end-to-end in full server mode — the
 *    same facts the doctor smoke prints, machine-checkable; the browser cap
 *    fails typed instead of launching the box into the OOM killer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgePosture } from "../src/workflows/posture.js";
import { locateBrowser } from "../src/core/cdp.js";
import { Controller } from "../src/core/controller.js";

const GOOD_FACTS = {
  ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  webdriver: false, webdriverNative: true,
  languages: ["en-US", "en"], intl: "en-US", tz: "America/New_York",
  cores: 8, memory: 8,
  webgl: true, renderer: "ANGLE (SwiftShader)",
  viewport: { w: 1919, h: 992, ow: 1920, oh: 1080, dpr: 1 },
  screen: { w: 1920, h: 1080, depth: 24, avail: 1080 },
  plugins: 5, pdfViewer: true, notifications: "denied", audioOffline: true,
};
const by = (report) => Object.fromEntries(report.checks.map((c) => [c.id, c.status]));

test("posture: a healthy server-lane browser passes every critical check", () => {
  const r = judgePosture({ facts: GOOD_FACTS, posture: { posture: "headed-on-virtual-display", display: ":42" }, egress: null }, { AXUSE_TIMEZONE: "America/New_York", AXUSE_LANG: "en-US" });
  const s = by(r);
  assert.equal(s["user-agent"], "pass");
  assert.equal(s["navigator.webdriver"], "pass");
  assert.equal(s["webgl"], "pass");
  assert.equal(s["timezone"], "pass");
  assert.equal(s["language"], "pass");
  assert.equal(s["pdf-plugins"], "pass");
  assert.equal(r.failures, 0);
});

test("posture: the headless class fails loudly", () => {
  const r = judgePosture({ facts: { ...GOOD_FACTS, ua: GOOD_FACTS.ua.replace("Chrome/151", "HeadlessChrome/151") }, posture: {} }, {});
  assert.equal(by(r)["user-agent"], "fail");
  assert.ok(r.failures >= 1);
  const wd = judgePosture({ facts: { ...GOOD_FACTS, webdriver: true }, posture: {} }, {});
  assert.equal(by(wd)["navigator.webdriver"], "fail");
  const noWebgl = judgePosture({ facts: { ...GOOD_FACTS, webgl: false, renderer: null }, posture: {} }, {});
  assert.equal(by(noWebgl)["webgl"], "fail");
});

test("posture: the masked-fallback script is a warn (build ignored the flag), never a silent pass", () => {
  const r = judgePosture({ facts: { ...GOOD_FACTS, webdriverNative: false }, posture: {} }, {});
  assert.equal(by(r)["navigator.webdriver"], "warn");
  assert.match(r.checks.find((c) => c.id === "navigator.webdriver").detail, /fallback script/);
});

test("posture: persona mismatches are diagnosed, not just failed", () => {
  const tz = judgePosture({ facts: { ...GOOD_FACTS, tz: "UTC" }, posture: {} }, { AXUSE_TIMEZONE: "America/New_York" });
  assert.equal(by(tz)["timezone"], "fail");
  assert.match(tz.checks.find((c) => c.id === "timezone").detail, /persona broken/);
  // Intl mismatch carries the locale-gen hint (the LC_ALL mechanism).
  const lang = judgePosture({ facts: { ...GOOD_FACTS, intl: "en-US", languages: ["en-GB"] }, posture: {} }, { AXUSE_LANG: "en-GB" });
  assert.equal(by(lang)["language"], "warn");
  assert.match(lang.checks.find((c) => c.id === "language").detail, /locale-gen/);
});

test("posture: egress geo vs clock — the fleet misconfiguration detector", () => {
  // Same area: pass.
  const ok = judgePosture({ facts: GOOD_FACTS, posture: {}, egress: { ip: "1.2.3.4", geo: { timezone: "America/Chicago", country: "United States" } } }, { AXUSE_TIMEZONE: "America/New_York" });
  assert.equal(by(ok)["egress"], "pass");
  // Different area: warn with both facts (caught live during development:
  // a Swiss exit behind an America/New_York persona).
  const bad = judgePosture({ facts: GOOD_FACTS, posture: {}, egress: { ip: "1.2.3.4", geo: { timezone: "Europe/Zurich", country: "Switzerland" } } }, { AXUSE_TIMEZONE: "America/New_York" });
  assert.equal(by(bad)["egress"], "warn");
  assert.match(bad.checks.find((c) => c.id === "egress").detail, /does not match the exit/);
  // Echo unreachable: info, never fail — the network says nothing about posture.
  const offline = judgePosture({ facts: GOOD_FACTS, posture: {}, egress: { ip: null, note: "echo unreachable: x" } }, {});
  assert.equal(by(offline)["egress"], "info");
});

const hasBrowser = !!locateBrowser();
const linux = process.platform === "linux";
const xvfb = linux && (await import("node:child_process")).spawnSync("which", ["Xvfb"]).status === 0;
const liveGate = hasBrowser && linux && xvfb;
const liveSkip = liveGate ? false : "requires Linux + Xvfb + a Chromium-family browser (the server-mode audit lane)";

test("posture: the live command audits the full server lane (json mode)", { skip: liveSkip }, async (t) => {
  const saved = { DISPLAY: process.env.DISPLAY, TZ: process.env.TZ };
  process.env.DISPLAY = ":988"; // dead → server mode boots the virtual display
  process.env.AXUSE_TIMEZONE = "America/New_York";
  t.after(() => {
    process.env.DISPLAY = saved.DISPLAY;
    delete process.env.AXUSE_TIMEZONE;
    if (saved.TZ === undefined) delete process.env.TZ; else process.env.TZ = saved.TZ;
  });
  const { collectPosture, judgePosture } = await import("../src/workflows/posture.js");
  const c = new Controller();
  t.after(() => c.dispose());
  const collected = await collectPosture(c);
  const report = judgePosture(collected, process.env);
  const s = by(report);
  assert.equal(collected.posture.posture, "headed-on-virtual-display");
  assert.match(collected.posture.display, /^:\d+$/);
  assert.equal(s["user-agent"], "pass");
  assert.equal(s["navigator.webdriver"], "pass", "native getter, zero tampering");
  assert.equal(s["webgl"], "pass", "SwiftShader on the virtual display");
  assert.equal(s["timezone"], "pass");
  assert.equal(report.failures, 0, JSON.stringify(report.checks.filter((x) => x.status === "fail")));
});

test("governance: the browser cap fails typed instead of OOM-killing the box", { skip: !hasBrowser ? "live-gate-browser: needs any Chromium-family browser" : false }, async (t) => {
  const prev = process.env.AXUSE_MAX_BROWSERS;
  process.env.AXUSE_MAX_BROWSERS = "1";
  t.after(() => { if (prev === undefined) delete process.env.AXUSE_MAX_BROWSERS; else process.env.AXUSE_MAX_BROWSERS = prev; });
  const c = new Controller();
  t.after(() => c.dispose());
  await c.execute("open", { url: "about:blank", headless: true, settle_ms: 100 });
  // Same launch key → reuse, never capped.
  const again = await c.execute("open", { url: "about:blank", headless: true, settle_ms: 100 });
  assert.ok(again.tab_id);
  // A DIFFERENT key (different proxy) at the cap → typed rejection.
  await assert.rejects(
    () => c.execute("open", { url: "about:blank", headless: true, proxy: "http://127.0.0.1:9", settle_ms: 100 }),
    (e) => e.code === "COMMAND_REJECTED" && /Browser cap reached/.test(e.message),
  );
});
