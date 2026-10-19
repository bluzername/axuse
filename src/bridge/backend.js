/**
 * axuse bridge — backend.
 *
 * Lineage: Codex's tab_cdp_call over chrome.debugger — the extension holds
 * real CDP over the user's real browser (cookies, logged-in sessions, 2FA
 * devices all present), and the harness drives it through a thin transport.
 * ExtensionBrowser duck-types the surface the Controller already uses for
 * CDP-launched browsers (conn/createTab/closeTabTarget/dispose), so the
 * entire frozen command contract — snapshots, diffs, trusted input, budgets
 * — runs unchanged against the user's daily Chrome.
 *
 * Known backend gap (documented honestly): chrome.debugger exposes no
 * Target domain, so OOPIF frames are listed but not entered here (the CDP
 * backend enters them).
 */
import { AxError, Codes } from "../core/errors.js";
import { getBridge } from "./hub.js";

/** conn-like surface over the bridge (duck-types CdpConnection where the
 *  controller cares: send / onEvent / close / closed). */
class ExtConn {
  constructor(bridge) {
    this.bridge = bridge;
    this.handlers = new Set();
    this.offRoute = bridge.onEvent((e) => {
      for (const h of this.handlers) { try { h(e); } catch {} }
    });
    this.closedFlag = false;
  }

  get closed() {
    return this.closedFlag;
  }

  async send(method, params, sessionId) {
    if (sessionId === undefined) {
      throw new AxError(Codes.COMMAND_REJECTED,
        `Command "${method}" needs a browser-level CDP domain the extension backend does not expose (chrome.debugger has no Target domain).`,
        { hint: "Use backend cdp (default) for that command.", retry: "never" });
    }
    let res;
    try {
      res = await this.bridge.rpc("cdp", { tabId: Number(sessionId), method, params: params ?? {} });
    } catch (e) {
      if (e instanceof AxError && e.code === Codes.TIMEOUT) {
        // Trunk-Chromium stall fallback (verified on r1721585 headless): a
        // Page.navigate RPC can hang while the SAME build answers
        // Runtime.evaluate fine. Route the navigation through the page once,
        // verify the URL actually changed, and answer with a navigate result.
        if (method === "Page.navigate" && typeof params?.url === "string") {
          return this.navigateViaEvaluate(params.url, sessionId);
        }
        // Side-effect accounting, same as the CDP backend: a timeout after
        // dispatch means the input may have landed.
        throw new AxError(Codes.TIMEOUT, e.message, { ...e, sideEffect: "uncertain" });
      }
      throw e;
    }
    if (!res.ok) {
      const s = String(res.error ?? "unknown error");
      if (/no attached target|tab.*(closed|not found)|detach/i.test(s)) {
        throw new AxError(Codes.ATTACH_FAILED, `CDP ${method} failed: ${s}`,
          { hint: "The tab was closed or the debugger detached (navigation can detach it; axuse re-attaches on the next command).", retry: "retry" });
      }
      throw new AxError(Codes.INTERNAL, `CDP ${method} failed: ${s}`);
    }
    return res.result ?? {};
  }

  /** Navigate by assignment when the debugger RPC stalls: the page executes
   *  location.href = url; we confirm with a same-turn read-back and return
   *  the Page.navigate result shape the controller expects. */
  async navigateViaEvaluate(url, sessionId) {
    const expr = `(function(){ location.href = ${JSON.stringify(url)}; return location.href; })()`;
    const res = await this.bridge.rpc("cdp", {
      tabId: Number(sessionId),
      method: "Runtime.evaluate",
      params: { expression: expr, returnByValue: true },
    });
    if (res.ok && res.result?.result?.value !== undefined) {
      return { frameId: null, loaderId: undefined, via: "location.href (Page.navigate RPC stalled — trunk-Chromium fallback)" };
    }
    throw new AxError(Codes.TIMEOUT,
      `Page.navigate stalled and the location.href fallback did not confirm (browser may be mid-detach).`,
      { hint: "Retry: the debugger re-attach on the next command usually restores the direct path.", retry: "retry", sideEffect: "uncertain" });
  }

  onEvent(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close() {
    this.closedFlag = true;
    try { this.offRoute && this.offRoute(); } catch {}
  }
}

/** BrowserHandle-compatible surface backed by the user's real Chrome. */
export class ExtensionBrowser {
  constructor(bridge) {
    this.bridge = bridge;
    this.conn = new ExtConn(bridge);
    this.tabs = new Set();
    this.launched = false; // we never launched it — it's the user's browser
    this.proc = null;
    this.userDataDir = null;
    this.createdTargets = new Set();
  }

  async waitOnline(timeoutMs = 20_000) {
    await this.bridge.waitExt(timeoutMs);
  }

  async createTab(url = "about:blank") {
    const res = await this.bridge.rpc("open_tab", { url });
    if (!res.ok) {
      throw new AxError(Codes.ATTACH_FAILED, `open_tab failed: ${res.error}`,
        { hint: "Is Chrome running with the axuse bridge extension loaded? (axuse bridge install; load bridge/extension unpacked)", retry: "retry" });
    }
    const tabId = String(res.result.tabId);
    for (const m of ["Page.enable", "Runtime.enable", "Log.enable"]) {
      await this.conn.send(m, {}, tabId);
    }
    // NOTE: no Target.setAutoAttach — chrome.debugger has no Target domain,
    // so OOPIF frames stay listed-but-not-entered on this backend.
    this.createdTargets.add(tabId);
    return { targetId: tabId, sessionId: tabId };
  }

  async closeTabTarget(targetId) {
    const id = String(targetId);
    this.createdTargets.delete(id);
    try { await this.bridge.rpc("close_tab", { tabId: Number(id) }); } catch {}
  }

  dispose() {
    // Codex semantics: disposing this backend closes the tabs WE created —
    // never the user's browser.
    const targets = [...this.createdTargets];
    this.createdTargets.clear();
    for (const t of targets) {
      void this.bridge.rpc("close_tab", { tabId: Number(t) }).catch(() => {});
    }
    this.conn.close();
  }
}

/** Build (and wait for) the extension-backed browser handle. */
export async function createExtensionHandle() {
  const bridge = await getBridge();
  const b = new ExtensionBrowser(bridge);
  await b.waitOnline(20_000);
  return b;
}
