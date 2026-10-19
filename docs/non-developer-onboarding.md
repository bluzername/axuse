# Axuse for journalists

## What this is

Axuse lets Codex or ChatGPT Work use a browser for research: opening pages,
searching, reading results, collecting links, and producing an evidence-backed
brief.

You do not need Git, Node.js, a terminal, or the Axuse source code.

There is one important requirement: Axuse must first be provided as an official
connector or signed desktop/browser installer by your organization. The source
repository currently contains the developer setup, not a finished consumer
installer. Do not download an unofficial browser extension.

## One-time setup

1. Install or enable the official Axuse connector supplied by your
   organization. In ChatGPT Work this will normally be listed as an app or
   connector. In Codex it may be supplied as a connector or desktop helper.
2. Open Chrome and approve the Axuse browser permission when Chrome asks.
   This is the one step that cannot safely be approved silently by an agent.
3. Start a new Codex or ChatGPT Work conversation and paste the following
   message.

```text
Set up Axuse for my browser research work.

Use only the official Axuse connector or installer that is already provided.
Do not ask me to clone a repository, install Node.js, edit configuration files,
or load an unpacked extension.

Please:

1. Connect Axuse to my default Chrome browser.
2. Start or configure any required Axuse bridge components.
3. If Chrome or the operating system needs my approval, pause and tell me
   exactly what to click.
4. Verify the connection by opening https://example.com and reading its page
   title and main content.
5. Confirm which browser is connected and that Axuse can open pages and read
   their content.
6. From now on, automatically use Axuse whenever I ask you to search the web,
   open a website, collect information, compare sources, or monitor news. I
   should not need to mention Axuse again.
7. Keep browser actions read-only unless I explicitly approve logging in,
   submitting a form, downloading a file, publishing, or contacting someone.

Do not report success until the example.com test has passed.
If Axuse is not installed or cannot be reached, explain that plainly and tell
me what the administrator needs to install. Do not invent a successful setup.
```

The setup is complete when the assistant reports a successful `example.com`
test. If it asks you to approve a browser permission, approve only the official
Axuse extension or connector.

## First test

Try a small browser request first:

```text
Open google.com and search for the latest news in the United States.
```

You should see Axuse open or use the browser. If the assistant answers from
memory without opening Google, say:

```text
Use the connected Axuse browser for this task. Show me the pages you opened
and their URLs before summarizing the results.
```

## Useful research prompts

### A news brief

```text
Search the latest US news from the last 24 hours. Use Axuse to open the
relevant results, deduplicate repeated wire stories, and prioritize primary
sources.

Create a concise Markdown brief with:
- headline
- outlet and publication time
- URL
- two-sentence summary
- the main claim supported by the source
- whether the source is primary or secondary
- uncertainty, missing information, and conflicting reports

Do not publish anything or contact anyone. Tell me which pages were blocked,
paywalled, or unavailable instead of guessing.
```

### Collect structured information

```text
Find the official press releases published by [ORGANIZATION] about [TOPIC]
between [START DATE] and [END DATE]. Open each source with Axuse and return a
table containing date, title, URL, named people or organizations, locations,
and the exact facts supported by each page. Mark anything you could not verify.
```

### Compare claims

```text
Investigate the claim that [CLAIM]. Use Axuse to open at least five distinct
sources, including the most relevant primary source. Separate verified facts,
source interpretations, and unresolved claims. Include URLs and publication
dates for every item.
```

### Save a report

```text
Repeat the research above and save the final result as a Markdown report and
a CSV source list. Include the collection time, every URL opened, and a note
for each source that was blocked, paywalled, or unavailable.
```

## How to ask for better results

Include four things when they matter:

- **Topic:** what you are investigating.
- **Time window:** for example, “since yesterday” or exact dates.
- **Source rules:** official sources, local outlets, public records, or a
  specific list of publications.
- **Output:** a brief, timeline, table, source list, or Markdown/CSV files.

You do not need to describe browser clicks. Say what you want researched and
the assistant should choose the Axuse browser actions.

## Safety rules

Axuse should be used as a research assistant, not as an invisible publishing
agent. Ask for confirmation before it:

- logs into an account or handles private messages;
- submits a form or sends an email;
- downloads files;
- publishes, edits, or deletes content;
- contacts a source or another person.

It should record URLs and collection times, distinguish primary from secondary
sources, and say when a page could not be read. Never treat a search-result
snippet as proof when the underlying page is unavailable.

## If something goes wrong

**“Axuse is not available.”** The official connector or desktop helper has not
been installed, or the conversation was opened before it was installed. Ask
the administrator to install Axuse, then start a new conversation.

**The browser is not connected.** Open Chrome, make sure the official Axuse
extension is enabled, and repeat the setup prompt. Do not install a second
extension with a similar name.

**A page is blocked or requires a login.** Ask Axuse to record the URL and
continue with accessible sources. Do not ask it to bypass a paywall, CAPTCHA,
or access control.

**The answer has no URLs.** Ask: “Redo this using Axuse, show every source URL
and publication date, and separate verified facts from your interpretation.”

## For the person installing Axuse

The non-developer experience is only complete when Axuse is distributed as an
official connector or signed installer. A repository checkout, a local
`src/cli.js` path, manual MCP configuration, and Chrome’s **Load unpacked**
workflow are developer setup steps and should not be given to journalists.
