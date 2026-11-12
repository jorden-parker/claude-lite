# Browsing

Use the `agent-browser` CLI through the shell for every task that needs a web page: opening a URL, reading a page, checking a UI change, or debugging a site. Don't use the web fetch tool for these.

1. `agent-browser open <url>` to load the page.
2. `agent-browser snapshot` to read the page as an accessibility tree with `@ref`s; `agent-browser click @ref` and `agent-browser fill @ref <text>` to interact.
3. `agent-browser console` and `agent-browser errors` for console logs and page errors.
4. `agent-browser screenshot <path>`, then read the image to check what is visible.
5. `agent-browser close` when done.

If `agent-browser` fails or is missing, say so plainly instead of claiming the page works.
