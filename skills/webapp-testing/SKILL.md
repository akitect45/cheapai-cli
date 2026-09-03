---
name: webapp-testing
description: Use when verifying a local web UI. Drive the page with Playwright via npx, wait for the real rendered DOM, then assert or screenshot. Works on Windows, macOS, and Linux.
---

# Web app testing

Do not invent a Python helper. Use Playwright through `npx` so the same flow works on Windows (`cmd`) and Unix (`bash -lc`).

## Flow

1. Confirm how the app starts (`package.json` scripts, port). Use `read_file` / `list_dir`.
2. If the server is not running, start it with `bash` and wait until the port answers.
3. Inspect static HTML first when the page is a file. For a SPA, wait for the rendered DOM.
4. Write a small Playwright script in the workspace, then run it.

```js
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(process.env.APP_URL || 'http://127.0.0.1:5173');
await page.waitForLoadState('networkidle');
await page.screenshot({ path: 'playwright-inspect.png', fullPage: true });
await browser.close();
```

Install/run without a global install when possible:

```text
npx --yes playwright install chromium
npx --yes playwright test
```

## Rules

- Wait for `networkidle` or a specific selector before reading the DOM
- Prefer `getByRole` / `getByText` over brittle CSS
- Close the browser even on failure
- `web_fetch` cannot see localhost; drive the browser or read source instead
- Keep the script in the repo so `/undo` can restore it. Do not dump huge traces into chat
