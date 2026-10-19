/**
 * axuse — screenshot capture with hard budgets.
 *
 * Lineage: ZCode enforces image budgets at the *protocol* boundary
 * (max 2 images × 200KB, "one raster per result", downscale guards) instead
 * of trusting the model to be frugal. Codex treats screenshots as optional,
 * croppable, explicitly-not-always-available ("screenshot_unavailable").
 *
 * Here: one raster per call (by construction), byte budget with automatic
 * quality fallback, then a typed error with a crop hint. Vision is an
 * on-demand escape hatch — never the default observation.
 */
import { AxError, Codes } from "./errors.js";

export const DEFAULT_BUDGET_BYTES = 200_000; // ~200KB, matches ZCode's cap
const RETRY_QUALITY = 45;

/** Exact payload size of a base64 string (padding-aware). */
function approxBytes(b64) {
  return Buffer.byteLength(Buffer.from(b64, "base64"));
}

/**
 * @param {import("./cdp.js").CdpConnection} conn
 * @param {string} sessionId
 */
export async function captureScreenshot(conn, sessionId, { crop, budgetBytes = DEFAULT_BUDGET_BYTES, quality = 80 } = {}) {
  const base = { format: "jpeg", quality, captureBeyondViewport: false };
  // Viewport geometry in CSS px. Clips are in document coordinates, so the
  // scroll offset is added; scale 1 renders at CSS resolution regardless of
  // devicePixelRatio, keeping image pixels == click coordinates.
  let vp = { x: 0, y: 0, w: 0, h: 0 };
  try {
    const m = await conn.send("Page.getLayoutMetrics", {}, sessionId);
    const v = m.cssVisualViewport ?? m.visualViewport;
    vp = { x: v.pageX ?? 0, y: v.pageY ?? 0, w: Math.round(v.clientWidth), h: Math.round(v.clientHeight) };
  } catch {}
  let region = { x: 0, y: 0, w: vp.w, h: vp.h };
  if (crop) {
    const { x, y, w, h } = crop;
    for (const [k, v] of Object.entries({ x, y, w, h })) {
      if (!Number.isFinite(v)) throw new AxError(Codes.BAD_COORDS, `crop.${k} must be a finite number`);
    }
    if (w < 1 || h < 1) throw new AxError(Codes.BAD_COORDS, "crop.w and crop.h must be ≥ 1");
    region = { x, y, w, h };
  }
  if (region.w > 0 && region.h > 0) {
    base.clip = { x: vp.x + region.x, y: vp.y + region.y, width: region.w, height: region.h, scale: 1 };
  }
  let res = await conn.send("Page.captureScreenshot", base, sessionId);
  let bytes = approxBytes(res.data);
  let usedQuality = quality;
  if (bytes > budgetBytes) {
    // One automatic fallback pass, then fail honestly.
    res = await conn.send("Page.captureScreenshot", { ...base, quality: RETRY_QUALITY }, sessionId);
    usedQuality = RETRY_QUALITY;
    bytes = approxBytes(res.data);
  }
  if (bytes > budgetBytes) {
    throw new AxError(Codes.SCREENSHOT_BUDGET_EXCEEDED,
      `Screenshot is ${bytes} bytes, over the ${budgetBytes} byte budget even at quality ${RETRY_QUALITY}.`,
      { hint: "Pass crop:{x,y,w,h} to capture just the region you need — or prefer ax_observe (text snapshot) when pixels are not required.", retry: "never" });
  }
  const geometry = region.w
    ? `image ${region.w}x${region.h} = viewport CSS px${crop ? ` (crop at ${region.x},${region.y})` : ""}; pass ax_click {x,y} in these same pixels${crop ? ` + (${region.x},${region.y})` : ""}`
    : "viewport size unknown";
  return { base64: res.data, bytes, quality: usedQuality, budget_bytes: budgetBytes, mime: "image/jpeg", geometry };
}
