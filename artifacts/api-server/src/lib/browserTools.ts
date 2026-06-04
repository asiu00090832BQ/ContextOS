import type {
  BrowserRecipe,
  ExecutionResult,
  ServerContext,
} from "./webTools";
import {
  assertSafeUrl,
  renderTemplate,
  resolveSafeTarget,
  safeFetch,
} from "./webTools";

/**
 * Browser-automation executor (Phase 2). Drives a headless Chromium via
 * Playwright to interact with sites that expose no usable API, then a rendered-
 * HTML fetch fallback when a browser runtime is unavailable. Every navigated
 * URL passes through the same SSRF guard used for HTTP tools.
 */

const STEP_TIMEOUT_MS = 20_000;
const NAV_TIMEOUT_MS = 30_000;

type PlaywrightModule = typeof import("playwright");

async function loadPlaywright(): Promise<PlaywrightModule | null> {
  try {
    return (await import("playwright")) as PlaywrightModule;
  } catch {
    return null;
  }
}

/** Fallback: fetch the start URL and return its raw HTML (no JS execution). */
async function renderedFetchFallback(
  recipe: BrowserRecipe,
  ctx: ServerContext,
  args: Record<string, unknown>,
  startedAt: number,
): Promise<ExecutionResult> {
  const url = renderTemplate(recipe.startUrl, args);
  try {
    const res = await safeFetch(
      url,
      {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": "ContextOS-WebTool/1.0",
        },
        timeoutMs: NAV_TIMEOUT_MS,
      },
      ctx.allowPrivateNetwork,
    );
    const html = (await res.text()).slice(0, 200_000);
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 50_000);
    return {
      ok: res.ok,
      kind: "browser",
      status: res.status,
      durationMs: Date.now() - startedAt,
      body: { mode: "rendered_fetch", text },
      extracted: { html: html.slice(0, 50_000) },
      ...(res.ok ? {} : { error: `HTTP ${res.status} ${res.statusText}` }),
    };
  } catch (err) {
    return {
      ok: false,
      kind: "browser",
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : "Rendered fetch failed.",
    };
  }
}

export async function executeBrowserTool(
  recipe: BrowserRecipe,
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<ExecutionResult> {
  const started = Date.now();
  const pw = await loadPlaywright();
  if (!pw) {
    return renderedFetchFallback(recipe, ctx, args, started);
  }

  let browser: Awaited<ReturnType<PlaywrightModule["chromium"]["launch"]>> | null =
    null;
  try {
    browser = await pw.chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(STEP_TIMEOUT_MS);

    // SSRF guard for ALL page-initiated requests (subresources, XHR, fetch),
    // not just explicit navigations — a loaded page must not be able to reach
    // private/internal addresses unless this server opted in.
    if (!ctx.allowPrivateNetwork) {
      await page.route("**/*", async (route) => {
        try {
          await resolveSafeTarget(route.request().url(), false);
          await route.continue();
        } catch {
          await route.abort("blockedbyclient");
        }
      });
    }

    const extracted: Record<string, unknown> = {};
    let extractIndex = 0;

    const navigate = async (rawUrl: string): Promise<void> => {
      const safe = await assertSafeUrl(rawUrl, ctx.allowPrivateNetwork);
      await page.goto(safe.toString(), {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
    };

    await navigate(renderTemplate(recipe.startUrl, args));

    for (const step of recipe.steps) {
      switch (step.action) {
        case "goto":
          await navigate(renderTemplate(step.url, args));
          break;
        case "click":
          await page.click(renderTemplate(step.selector, args));
          break;
        case "type":
          await page.fill(
            renderTemplate(step.selector, args),
            renderTemplate(step.text, args),
          );
          break;
        case "waitFor":
          await page.waitForSelector(renderTemplate(step.selector, args));
          break;
        case "extractText": {
          const key = step.as ?? `text_${extractIndex++}`;
          const sel = step.selector ? renderTemplate(step.selector, args) : "body";
          extracted[key] = (await page.locator(sel).allInnerTexts()).join("\n");
          break;
        }
        case "extractAttribute": {
          const key = step.as ?? `attr_${extractIndex++}`;
          const sel = renderTemplate(step.selector, args);
          extracted[key] = await page
            .locator(sel)
            .first()
            .getAttribute(step.attribute);
          break;
        }
        case "screenshot": {
          const key = step.as ?? `screenshot_${extractIndex++}`;
          const buf = await page.screenshot({ type: "png" });
          extracted[key] = `data:image/png;base64,${buf.toString("base64")}`;
          break;
        }
      }
    }

    return {
      ok: true,
      kind: "browser",
      durationMs: Date.now() - started,
      body: { mode: "playwright", url: page.url() },
      extracted,
    };
  } catch (err) {
    return {
      ok: false,
      kind: "browser",
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : "Browser automation failed.",
    };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}
