# Server mode — axuse on Ubuntu servers (no desktop, no display)

Server mode is the supported lane for running axuse under agent CLIs (Codex,
Claude Code, OpenCode, …) on a headless **Ubuntu server**: **fully HEADED
Chrome on an auto-provisioned X virtual framebuffer (Xvfb)**.

It exists because of one fact this repo's live testing keeps confirming:
challenge and anti-bot systems (Cloudflare Turnstile, DataDome, Geetest,
AWS WAF, reCAPTCHA, slider gates) check *is this a headless browser?* as
their **first step**. `--headless` / `--headless=new` is a detection signal,
not a workaround. A headed Chrome rendering into a private Xvfb has no
headless fingerprint at all: real window, real font stack, real raster
pipeline, WebGL (software fallback), windowed viewport — every signal a
human-driven desktop Chrome has.

```
server (no DISPLAY) ── ax_open ──► auto-boot private Xvfb (:NNN, 1920x1080x24)
                              └─► HEADED Chrome on it (never --headless)
                                  · UA has no "Headless" substring
                                  · navigator.webdriver === false (neutralized)
                                  · WebGL present (SwiftShader fallback re-enabled)
                                  · trusted CDP input — the solver lane works as-is
```

Nothing about the model-facing surface changes: `ax_open`, `ax_observe`,
`ax_click`, `ax_solve_captcha {provider}`, sliders, screenshots — all work
exactly as on a desktop. The `ax_open` result carries the fact so the agent
(and you) can see it:

```
display: :762 (virtual 1920x1080 — headed on Xvfb, server mode)
```

## One-time server setup

```bash
# Node >= 22, a Chromium-family browser, Xvfb and real fonts.
sudo apt-get update
sudo apt-get install -y nodejs xvfb fonts-liberation fonts-dejavu-core fontconfig
# Chrome (either the distro package or Chrome for Testing):
wget -qO- https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).channels.Stable.downloads.chrome.find(x=>x.platform==="linux64").url))' \
  | xargs curl -sL -o /tmp/cft.zip && unzip -q /tmp/cft.zip -d /opt/axuse-cft
sudo ln -sf /opt/axuse-cft/chrome-linux64/chrome /usr/local/bin/axuse-chrome
# Or the classic .deb: sudo apt-get install -y google-chrome-stable
#   (from Google's repo; any Chromium-family build works — AXUSE_BROWSER points at it)

node src/cli.js doctor   # must say: "server mode: ready"
```

Fonts are not cosmetic: without fontconfig + font packages, text renders as
boxes, every screenshot is garbage, and vision-based solvers (slider
geometry crops, icon puzzles) fail. `doctor` checks this.

## Wire it into the harness on the server

Same as on a desktop — the MCP server does the rest:

```bash
codex mcp add axuse -- node /srv/axuse/src/cli.js mcp
claude mcp add --scope user axuse -- node /srv/axuse/src/cli.js mcp
node src/cli.js print-config --harness opencode   # or agy | generic
```

`doctor` under the service user must print the `server mode: ready` line
before you rely on it.

### systemd service (the whole browser stack under one cgroup)

One service per long-running harness. `KillMode=control-group` guarantees
the private Xvfb dies with the agent process — no orphans:

```ini
# /etc/systemd/system/codex-axuse.service
[Service]
Type=exec
User=codex-agent
Environment=AXUSE_BROWSER=/usr/local/bin/axuse-chrome
Environment=CAPTCHA_PRO_VISION_KEY=sk-or-v1-…        # solver vision key (see below)
# Environment=AXUSE_PROFILE_DIR=/var/lib/axuse/profiles
ExecStart=/usr/bin/codex            # or claude / opencode serve
KillMode=control-group
Restart=on-failure
```

For one-shot / cron-style runs no service is needed — `axuse solve`,
`axuse open-urls` and the MCP server all boot and reap their own Xvfb.

## Environment reference (server lane)

| variable | effect |
|---|---|
| `AXUSE_SERVER_MODE` | `auto` (default) — boot a private Xvfb when Linux + no live display. `0`/`off` disables it (headed launches then fail typed with guidance). |
| `AXUSE_DISPLAY_SIZE` | Virtual display geometry, default `1920x1080x24`. |
| `AXUSE_NO_SANDBOX` | `1` forces `--no-sandbox`. Auto-applied anyway when running as root (containers) — Chrome refuses root otherwise. |
| `AXUSE_BROWSER` | Path to the browser binary (as on any host). |
| `AXUSE_PROFILE_DIR` | Where browser profiles go (defaults to the OS temp dir). |
| `AXUSE_NEUTRALIZE_WEBDRIVER` | `0` disables the `navigator.webdriver` neutralizer (see below). Default: on. |
| `AXUSE_HEADLESS` | **Do not set on servers with challenge traffic.** Forces `--headless` for every launch — the exact signal anti-bot systems look for. It stays available for trusted internal pages. |

Every knob is checked by `node src/cli.js doctor` — run it first, it tells
you what is missing (Xvfb, fonts, root sandbox, a stray `AXUSE_HEADLESS`).

## Vision solvers on servers (the multimodal LLM by API)

Solver plugins that need eyes (slider geometry on cross-origin crops, icon
puzzles) call a vision model through a plain OpenAI-compatible HTTP API —
that already *is* the server shape; no local model, no GUI needed:

| plugin env | default |
|---|---|
| `<PREFIX>_VISION_KEY` | (required) e.g. an OpenRouter key |
| `<PREFIX>_VISION_BASE` | `https://openrouter.ai/api/v1` |
| `<PREFIX>_VISION_MODEL` | plugin default (e.g. `google/gemini-4-argon`) |

`<PREFIX>` is the plugin's env namespace (`CAPTCHA_PRO_*`, `CHALLENGE_*`).
The base accepts any OpenAI-compatible endpoint — OpenRouter (default,
one key, many models), OpenAI, Gemini's OpenAI-compat endpoint
(`https://generativelanguage.googleapis.com/v1beta/openai`), Anthropic's
(`/v1/chat/completions`), or a private gateway/proxy.

### Storing keys on a server (no macOS Keychain there)

- env vars (systemd `Environment=`, shell profile), **or**
- the axuse secrets file — the server-side Keychain equivalent:

```bash
mkdir -p ~/.config/axuse
# keys are the plugin account slug OR the env-var name; owner-only mode
cat > ~/.config/axuse/secrets.json <<'EOF'
{
  "captcha-pro-vision": "sk-or-v1-…",
  "challenge-vision": "sk-or-v1-…"
}
EOF
chmod 600 ~/.config/axuse/secrets.json
```

`AXUSE_SECRETS_FILE` overrides the path. A file the group/world can read is
refused (fix: `chmod 600`). Typed failure messages name the exact options.

## Scaling out (massive operations)

- **One private Xvfb per axuse process** (display numbers are picked away
  from live ones; the display survives browser restarts within the
  process). N agent processes → N isolated displays, no contention, no
  shared mouse/keyboard state — unlike one shared desktop.
- **Bounded batches**: `ax_open_many {urls:[…]}` (≤100/round) for scraping
  lanes; solver traffic stays on one tab via `ax_solve_captcha {provider}`.
- **Aged sessions**: persistent profiles (the session-vault plugin, or
  `profile_dir`) survive process restarts — warmer profiles pass challenges
  more often. Server mode keeps killed profiles from waking up behind the
  "restore pages?" bubble.
- **Containers**: root runs get `--no-sandbox` automatically; small
  `/dev/shm` is mitigated automatically (`--disable-dev-shm-usage`);
  `doctor` reports both.
- **Cleanup**: the Xvfb is a child of the axuse process — normal exits and
  process-group kills reap it; under systemd use `KillMode=control-group`.

## What is deliberately NOT done

- **No headless for challenge pages.** Ever. That is the whole point.
- **No DOM tampering with challenge logic.** The only page-level patch is
  the `navigator.webdriver` neutralizer: modern Chrome sets it to `true`
  merely because a DevTools client is attached — a fingerprint of *our own
  plumbing*, present on no human-driven Chrome. axuse restores the exact
  value a human browser reports (`false`), before any page script runs.
  It does not fake, answer or shortcut any challenge — solvers still click
  real widgets with trusted input. Opt out: `AXUSE_NEUTRALIZE_WEBDRIVER=0`.
- **No fabricated results.** Solvers report `solved: false` honestly when
  a page hard-blocks; `doctor` and tests state measured numbers.

## Verify it (all commands runnable on the server)

```bash
node src/cli.js doctor
# server mode: ready — no live X display; headed Chrome will auto-boot a
#   private Xvfb (1920x1080x24, NOT headless — anti-bot-safe; …)
# fonts: … (only printed when fonts are missing)
# smoke test: server mode — booting a virtual display, launching HEADED Chrome…
# server-mode facts: display :762 (virtual) · UA headed (no Headless substring)
#   · navigator.webdriver false · viewport 1919x992 · WebGL present (SwiftShader)
# server-mode anti-bot posture: OK — indistinguishable headed build

node --test test/server-mode.test.js     # the same assertions, in CI and locally
```
