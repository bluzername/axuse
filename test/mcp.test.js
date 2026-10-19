/**
 * MCP protocol test — spawns the real CLI server, does a real handshake,
 * lists tools, and drives a real browser through the MCP boundary.
 * Gated on a findable browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { locateBrowser } from "../src/core/cdp.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const hasBrowser = !!locateBrowser();

function startServer() {
  const proc = spawn(process.execPath, [CLI, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  const buffer = { text: "", waiters: [] };
  proc.stdout.on("data", (d) => {
    buffer.text += String(d);
    let i;
    while ((i = buffer.text.indexOf("\n")) >= 0) {
      const line = buffer.text.slice(0, i).trim();
      buffer.text = buffer.text.slice(i + 1);
      if (!line) continue;
      const w = buffer.waiters.shift();
      if (w) w(JSON.parse(line));
    }
  });
  let err = "";
  proc.stderr.on("data", (d) => { err += String(d); });
  return {
    proc,
    async call(msg) {
      const p = new Promise((resolve, reject) => {
        buffer.waiters.push(resolve);
        setTimeout(() => reject(new Error(`MCP response timeout\nstderr: ${err}`)), 60_000);
      });
      proc.stdin.write(JSON.stringify(msg) + "\n");
      return p;
    },
    end() { proc.kill(); },
  };
}

test("mcp: handshake, tools/list, tools/call end-to-end", { skip: !hasBrowser }, async (t) => {
  const srv = startServer();
  t.after(() => srv.end());

  const init = await srv.call({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });
  assert.equal(init.result.serverInfo.name, "axuse");
  assert.ok(init.result.capabilities.tools);

  srv.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await srv.call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = list.result.tools.map((x) => x.name);
  assert.ok(names.includes("ax_open"));
  assert.ok(names.includes("ax_observe"));
  assert.ok(names.includes("ax_click"));
  assert.ok(names.includes("ax_screenshot"));
  assert.ok(names.includes("ax_open_many"));
  // Desktop tools are advertised when the platform driver is enabled.
  const desktopExpected = process.platform === "win32" || (process.platform === "darwin" && process.env.AXUSE_ENABLE_MACOS_CUA === "1");
  if (desktopExpected) {
    assert.ok(names.includes("ax_desktop_screenshot"));
  } else {
    assert.ok(!names.includes("ax_desktop_screenshot"));
  }
  // The macOS AX-structure tools mount ONLY with the macOS driver;
  // Windows (coordinate driver) must not advertise them.
  if (process.platform === "darwin" && process.env.AXUSE_ENABLE_MACOS_CUA === "1") {
    for (const t of ["ax_desktop_ax_snapshot", "ax_desktop_ax_click", "ax_desktop_ax_set", "ax_desktop_ax_read"]) {
      assert.ok(names.includes(t), `${t} mounted with the macOS driver`);
    }
  } else {
    for (const t of ["ax_desktop_ax_snapshot", "ax_desktop_ax_click", "ax_desktop_ax_set", "ax_desktop_ax_read"]) {
      assert.ok(!names.includes(t), `${t} must not mount without the macOS AX layer`);
    }
  }

  if (desktopExpected) {
    const screen = await srv.call({
      jsonrpc: "2.0", id: 20, method: "tools/call",
      params: { name: "ax_desktop_screen_info", arguments: {} },
    });
    assert.equal(screen.result.isError, undefined);
    const screenInfo = JSON.parse(screen.result.content[0].text);
    assert.ok(screenInfo.w > 0 && screenInfo.h > 0);
    if (process.platform === "darwin") assert.equal(screenInfo.coordinate_space, "macOS global display points");
  }

  const page = `data:text/html,<button id="b" onclick="document.getElementById('o').textContent='done'">go</button><div id="o" style="min-height:1em"></div>`;
  const opened = await srv.call({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "ax_open", arguments: { url: page, headless: true, settle_ms: 100 } },
  });
  assert.equal(opened.result.isError, undefined);
  // Observations render as plain text (no JSON escaping of the tree).
  const openText = opened.result.content[0].text;
  assert.match(openText, /^tab: t\d+\nurl: /);
  assert.match(openText, /button "go"/);

  const ref = openText.match(/button "go"[^\[]*\[ref=(e\d+)\]/)[1];
  const clicked = await srv.call({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "ax_click", arguments: { target: { ref }, settle_ms: 150 } },
  });
  const clickText = clicked.result.content[0].text;
  assert.doesNotMatch(clickText, /^action: /); // "sent" is the silent default
  assert.match(clickText, /text "done"|changed/);

  // Structured error surfaces as isError result, not a protocol crash.
  const bad = await srv.call({
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "ax_click", arguments: { target: { ref: "e999" } } },
  });
  assert.equal(bad.result.isError, true);
  const err = JSON.parse(bad.result.content[0].text);
  assert.equal(err.code, "REF_NOT_FOUND");
  assert.equal(err.retry, "reobserve");

  const batch = await srv.call({
    jsonrpc: "2.0", id: 7, method: "tools/call",
    params: {
      name: "ax_open_many",
      arguments: {
        urls: [
          "data:text/html,<title>batch</title><h1>batch page</h1>",
          "data:text/html,<h1>second page</h1>",
        ],
        headless: true,
        settle_ms: 80,
        excerpt_chars: 200,
      },
    },
  });
  assert.equal(batch.result.isError, undefined);
  const batchPayload = JSON.parse(batch.result.content[0].text);
  assert.equal(batchPayload.opened, 2);
  assert.equal(batchPayload.failed, 0);
  assert.match(batchPayload.results[0].excerpt, /heading "batch page"/);

  await srv.call({
    jsonrpc: "2.0", id: 8, method: "tools/call",
    params: { name: "ax_close", arguments: { browser: true } },
  });
});
