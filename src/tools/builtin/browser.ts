import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import type { JsonValue, ToolDefinition, ToolInput } from "../types.js";

type BrowserToolOutput = {
  status: "ok" | "error";
  note: string;
  sessionId?: string;
  currentUrl?: string;
  data?: JsonValue;
  target?: {
    x: number;
    y: number;
    selector?: string;
  };
  received: ToolInput;
};

type BrowserSession = {
  id: string;
  browser: any;
  context: any;
  page: any;
  userAgent: string;
  viewport: { width: number; height: number };
  cursor: { x: number; y: number };
  createdAtIso: string;
};

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
];

class HumanizedBrowserManager {
  private session: BrowserSession | null = null;
  private cleanupHooksAttached = false;

  async createSession(input: ToolInput): Promise<BrowserToolOutput> {
    const url = toStringValue(input.url);
    if (!url) {
      return {
        status: "error",
        note: "missing required argument: url",
        received: input,
      };
    }

    const playwright = await loadPlaywright();
    if (!playwright.ok) {
      return {
        status: "error",
        note: playwright.error,
        received: input,
      };
    }

    await this.closeSession();
    this.attachCleanupHooks();

    const userAgent = toStringValue(input.userAgent) || randomPick(USER_AGENTS);
    const headless = toBooleanValue(input.headless, true);
    const width = clampInt(toNumberValue(input.width, randomInt(1280, 1440)) ?? 1366, 960, 2560);
    const height = clampInt(toNumberValue(input.height, randomInt(720, 980)) ?? 850, 640, 1440);
    const timeoutMs = clampInt(toNumberValue(input.timeoutMs, 25_000) ?? 25_000, 1_000, 120_000);

    try {
      const browser = await playwright.chromium.launch({
        headless,
        args: [
          "--disable-blink-features=AutomationControlled",
          "--disable-features=IsolateOrigins,site-per-process",
          "--disable-dev-shm-usage",
        ],
      });

      const context = await browser.newContext({
        userAgent,
        locale: "en-US",
        timezoneId: "America/New_York",
        viewport: { width, height },
        deviceScaleFactor: 1,
        hasTouch: false,
        colorScheme: "light",
      });

      await context.addInitScript(
        ({ seed }: { seed: number }) => {
          const seeded = (n: number) => ((Math.sin(n + seed) + 1) / 2);
          const clampByteLocal = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

          try {
            Object.defineProperty(navigator, "webdriver", { get: () => undefined });
            Object.defineProperty(navigator, "language", { get: () => "en-US" });
            Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
            Object.defineProperty(navigator, "platform", { get: () => "Win32" });
          } catch {
            // ignore
          }

          try {
            if (!(window as { chrome?: unknown }).chrome) {
              Object.defineProperty(window, "chrome", {
                value: { runtime: {} },
                configurable: true,
              });
            }
          } catch {
            // ignore
          }

          try {
            const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
            CanvasRenderingContext2D.prototype.getImageData = function (
              sx: number,
              sy: number,
              sw: number,
              sh: number,
              settings?: ImageDataSettings,
            ): ImageData {
              const imageData = originalGetImageData.call(this, sx, sy, sw, sh, settings);
              const d = imageData.data;
              if (d.length > 4) {
                const offset = Math.floor(seeded(d.length) * (d.length - 4));
                const delta = Math.floor(seeded(offset) * 3) - 1;
                d[offset] = clampByteLocal(d[offset]! + delta);
                d[offset + 1] = clampByteLocal(d[offset + 1]! + delta);
                d[offset + 2] = clampByteLocal(d[offset + 2]! + delta);
              }
              return imageData;
            };
          } catch {
            // ignore
          }

          try {
            const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
            WebGLRenderingContext.prototype.getParameter = function (parameter: number): unknown {
              if (parameter === 37445) {
                return "Intel Inc.";
              }
              if (parameter === 37446) {
                return "Intel Iris OpenGL Engine";
              }
              return originalGetParameter.call(this, parameter);
            };
          } catch {
            // ignore
          }
        },
        { seed: randomInt(11, 999_999) },
      );

      const page = await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });

      const cursor = {
        x: randomInt(Math.floor(width * 0.3), Math.floor(width * 0.7)),
        y: randomInt(Math.floor(height * 0.25), Math.floor(height * 0.75)),
      };
      await page.mouse.move(cursor.x, cursor.y);

      this.session = {
        id: `browser-${Date.now().toString(36)}`,
        browser,
        context,
        page,
        userAgent,
        viewport: { width, height },
        cursor,
        createdAtIso: new Date().toISOString(),
      };

      return {
        status: "ok",
        note: `opened browser at ${sanitizeForLog(await page.url())}`,
        sessionId: this.session.id,
        currentUrl: await page.url(),
        received: input,
      };
    } catch (error) {
      await this.closeSession();
      return {
        status: "error",
        note: error instanceof Error ? error.message : String(error),
        received: input,
      };
    }
  }

  async closeSession(): Promise<BrowserToolOutput> {
    if (!this.session) {
      return {
        status: "ok",
        note: "no active browser session",
        received: {},
      };
    }

    const sessionId = this.session.id;
    const currentUrl = safeUrl(this.session.page);
    try {
      await this.session.context.close();
    } catch {
      // ignore close errors
    }
    try {
      await this.session.browser.close();
    } catch {
      // ignore close errors
    }
    this.session = null;
    return {
      status: "ok",
      note: "closed browser session",
      sessionId,
      currentUrl,
      received: {},
    };
  }

  async click(input: ToolInput): Promise<BrowserToolOutput> {
    const session = this.requireSession(input);
    if (!session.ok) {
      return session.output;
    }

    const page = session.session.page;
    const button = normalizeButton(toStringValue(input.button));
    const resolved = await resolveTargetPoint(page, input);
    if (!resolved.ok) {
      return {
        status: "error",
        note: resolved.error,
        sessionId: session.session.id,
        currentUrl: safeUrl(page),
        received: input,
      };
    }

    const targetX = resolved.point.x + randomFloat(-2.6, 2.6);
    const targetY = resolved.point.y + randomFloat(-2.6, 2.6);
    await moveMouseHumanized(page, session.session.cursor, { x: targetX, y: targetY });
    session.session.cursor = { x: targetX, y: targetY };

    await page.mouse.down({ button });
    await page.waitForTimeout(randomInt(35, 95));
    await page.mouse.up({ button });
    await page.waitForTimeout(randomInt(30, 120));

    return {
      status: "ok",
      note: "click completed",
      sessionId: session.session.id,
      currentUrl: safeUrl(page),
      target: {
        x: round2(targetX),
        y: round2(targetY),
        selector: resolved.selector,
      },
      received: input,
    };
  }

  async drag(input: ToolInput): Promise<BrowserToolOutput> {
    const session = this.requireSession(input);
    if (!session.ok) {
      return session.output;
    }

    const page = session.session.page;
    const from = await resolveDragPoint(page, input, "from");
    if (!from.ok) {
      return {
        status: "error",
        note: from.error,
        sessionId: session.session.id,
        currentUrl: safeUrl(page),
        received: input,
      };
    }

    const to = await resolveDragPoint(page, input, "to");
    if (!to.ok) {
      return {
        status: "error",
        note: to.error,
        sessionId: session.session.id,
        currentUrl: safeUrl(page),
        received: input,
      };
    }

    await moveMouseHumanized(page, session.session.cursor, from.point, 30);
    session.session.cursor = { ...from.point };
    await page.mouse.down();
    await page.waitForTimeout(randomInt(40, 110));
    await moveMouseHumanized(page, session.session.cursor, to.point, 40);
    session.session.cursor = { ...to.point };
    await page.waitForTimeout(randomInt(20, 60));
    await page.mouse.up();

    return {
      status: "ok",
      note: "drag completed",
      sessionId: session.session.id,
      currentUrl: safeUrl(page),
      target: {
        x: round2(to.point.x),
        y: round2(to.point.y),
      },
      received: input,
    };
  }

  async scroll(input: ToolInput): Promise<BrowserToolOutput> {
    const session = this.requireSession(input);
    if (!session.ok) {
      return session.output;
    }

    const page = session.session.page;
    const target = toStringValue(input.target);
    if (target) {
      const picked = await pickLocator(page, target, {
        timeoutMs: 8_000,
        requireVisible: false,
      });
      if (!picked.ok) {
        return {
          status: "error",
          note: picked.error,
          sessionId: session.session.id,
          currentUrl: safeUrl(page),
          received: input,
        };
      }
      await picked.locator.scrollIntoViewIfNeeded().catch(() => {});
    }

    const x = toNumberValue(input.x, 0) ?? 0;
    const y = toNumberValue(input.y, target ? 240 : 420) ?? (target ? 240 : 420);
    const segments = Math.max(1, Math.min(8, Math.round(Math.abs(y) / 180)));
    const stepX = x / segments;
    const stepY = y / segments;

    for (let i = 0; i < segments; i += 1) {
      const jitterX = randomFloat(-5, 5);
      const jitterY = randomFloat(-12, 12);
      await page.mouse.wheel(stepX + jitterX, stepY + jitterY);
      await page.waitForTimeout(randomInt(20, 75));
    }

    return {
      status: "ok",
      note: target ? `scrolled to ${target}` : "scroll completed",
      sessionId: session.session.id,
      currentUrl: safeUrl(page),
      received: input,
    };
  }

  async type(input: ToolInput): Promise<BrowserToolOutput> {
    const session = this.requireSession(input);
    if (!session.ok) {
      return session.output;
    }

    const page = session.session.page;
    const text = toStringValue(input.text);
    if (!text) {
      return {
        status: "error",
        note: "missing required argument: text",
        sessionId: session.session.id,
        currentUrl: safeUrl(page),
        received: input,
      };
    }

    const selector = toStringValue(input.selector);
    const submit = toBooleanValue(input.submit, false);
    const clear = toBooleanValue(input.clear, false);

    if (selector) {
      const resolved = await resolveTargetPoint(page, { selector });
      if (!resolved.ok) {
        return {
          status: "error",
          note: resolved.error,
          sessionId: session.session.id,
          currentUrl: safeUrl(page),
          received: input,
        };
      }

      await moveMouseHumanized(page, session.session.cursor, resolved.point);
      session.session.cursor = { ...resolved.point };
      await page.mouse.click(resolved.point.x, resolved.point.y, {
        delay: randomInt(25, 80),
      });
      if (clear) {
        await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.press("Backspace");
      }
    }

    for (const ch of text) {
      await page.keyboard.type(ch, { delay: randomInt(20, 70) });
    }

    if (submit) {
      await page.keyboard.press("Enter");
    }

    return {
      status: "ok",
      note: selector ? `typed into ${selector}` : "typed text",
      sessionId: session.session.id,
      currentUrl: safeUrl(page),
      received: input,
    };
  }

  async wait(input: ToolInput): Promise<BrowserToolOutput> {
    const session = this.requireSession(input);
    if (!session.ok) {
      return session.output;
    }

    const page = session.session.page;
    const selector = toStringValue(input.selector);
    const timeoutMs = clampInt(toNumberValue(input.timeoutMs, 10_000) ?? 10_000, 250, 120_000);
    const ms = clampInt(toNumberValue(input.ms, 500) ?? 500, 10, 120_000);

    if (selector) {
      await page.waitForSelector(selector, { timeout: timeoutMs, state: "visible" });
    } else {
      await page.waitForTimeout(ms);
    }

    return {
      status: "ok",
      note: selector ? `waited for ${selector}` : `waited ${ms}ms`,
      sessionId: session.session.id,
      currentUrl: safeUrl(page),
      received: input,
    };
  }

  async navigate(input: ToolInput): Promise<BrowserToolOutput> {
    const session = this.requireSession(input);
    if (!session.ok) {
      return session.output;
    }

    const page = session.session.page;
    const url = toStringValue(input.url);
    if (!url) {
      return {
        status: "error",
        note: "missing required argument: url",
        sessionId: session.session.id,
        currentUrl: safeUrl(page),
        received: input,
      };
    }

    const timeoutMs = clampInt(toNumberValue(input.timeoutMs, 25_000) ?? 25_000, 1_000, 120_000);
    const waitUntil = normalizeWaitUntil(toStringValue(input.waitUntil));
    await page.goto(url, { timeout: timeoutMs, waitUntil });

    return {
      status: "ok",
      note: `navigated to ${sanitizeForLog(safeUrl(page) ?? url)}`,
      sessionId: session.session.id,
      currentUrl: safeUrl(page),
      received: input,
    };
  }

  async reload(input: ToolInput): Promise<BrowserToolOutput> {
    const session = this.requireSession(input);
    if (!session.ok) {
      return session.output;
    }

    const page = session.session.page;
    const timeoutMs = clampInt(toNumberValue(input.timeoutMs, 20_000) ?? 20_000, 1_000, 120_000);
    const waitUntil = normalizeWaitUntil(toStringValue(input.waitUntil));
    await page.reload({ timeout: timeoutMs, waitUntil });

    return {
      status: "ok",
      note: "page reloaded",
      sessionId: session.session.id,
      currentUrl: safeUrl(page),
      received: input,
    };
  }

  async goBack(input: ToolInput): Promise<BrowserToolOutput> {
    const session = this.requireSession(input);
    if (!session.ok) {
      return session.output;
    }

    const page = session.session.page;
    const timeoutMs = clampInt(toNumberValue(input.timeoutMs, 20_000) ?? 20_000, 1_000, 120_000);
    await page.goBack({ timeout: timeoutMs, waitUntil: "domcontentloaded" });

    return {
      status: "ok",
      note: "navigated back",
      sessionId: session.session.id,
      currentUrl: safeUrl(page),
      received: input,
    };
  }

  async goForward(input: ToolInput): Promise<BrowserToolOutput> {
    const session = this.requireSession(input);
    if (!session.ok) {
      return session.output;
    }

    const page = session.session.page;
    const timeoutMs = clampInt(toNumberValue(input.timeoutMs, 20_000) ?? 20_000, 1_000, 120_000);
    await page.goForward({ timeout: timeoutMs, waitUntil: "domcontentloaded" });

    return {
      status: "ok",
      note: "navigated forward",
      sessionId: session.session.id,
      currentUrl: safeUrl(page),
      received: input,
    };
  }

  async hover(input: ToolInput): Promise<BrowserToolOutput> {
    const session = this.requireSession(input);
    if (!session.ok) {
      return session.output;
    }

    const page = session.session.page;
    const resolved = await resolveTargetPoint(page, input);
    if (!resolved.ok) {
      return {
        status: "error",
        note: resolved.error,
        sessionId: session.session.id,
        currentUrl: safeUrl(page),
        received: input,
      };
    }

    const targetX = resolved.point.x + randomFloat(-2.1, 2.1);
    const targetY = resolved.point.y + randomFloat(-2.1, 2.1);
    await moveMouseHumanized(page, session.session.cursor, { x: targetX, y: targetY });
    session.session.cursor = { x: targetX, y: targetY };
    await page.waitForTimeout(randomInt(40, 140));

    return {
      status: "ok",
      note: resolved.selector ? `hovered ${resolved.selector}` : "hovered",
      sessionId: session.session.id,
      currentUrl: safeUrl(page),
      target: {
        x: round2(targetX),
        y: round2(targetY),
        selector: resolved.selector,
      },
      received: input,
    };
  }

  async pressKey(input: ToolInput): Promise<BrowserToolOutput> {
    const session = this.requireSession(input);
    if (!session.ok) {
      return session.output;
    }

    const page = session.session.page;
    const key = toStringValue(input.key);
    if (!key) {
      return {
        status: "error",
        note: "missing required argument: key",
        sessionId: session.session.id,
        currentUrl: safeUrl(page),
        received: input,
      };
    }

    const count = clampInt(toNumberValue(input.count, 1) ?? 1, 1, 20);
    const delayMs = clampInt(toNumberValue(input.delayMs, 35) ?? 35, 0, 500);
    for (let i = 0; i < count; i += 1) {
      await page.keyboard.press(key, { delay: delayMs });
      await page.waitForTimeout(randomInt(12, 60));
    }

    return {
      status: "ok",
      note: count > 1 ? `pressed ${key} x${count}` : `pressed ${key}`,
      sessionId: session.session.id,
      currentUrl: safeUrl(page),
      received: input,
    };
  }

  async getPageInfo(input: ToolInput): Promise<BrowserToolOutput> {
    const session = this.requireSession(input);
    if (!session.ok) {
      return session.output;
    }

    const page = session.session.page;
    const title = await page.title();
    const readyState = await page.evaluate(() => document.readyState);
    return {
      status: "ok",
      note: `page: ${sanitizeForLog(title || "(untitled)")}`,
      sessionId: session.session.id,
      currentUrl: safeUrl(page),
      data: {
        title,
        url: safeUrl(page) ?? "",
        readyState,
        userAgent: session.session.userAgent,
        viewport: session.session.viewport,
        createdAtIso: session.session.createdAtIso,
      },
      received: input,
    };
  }

  async getHtml(input: ToolInput): Promise<BrowserToolOutput> {
    const session = this.requireSession(input);
    if (!session.ok) {
      return session.output;
    }

    const page = session.session.page;
    const selector = toStringValue(input.selector);
    const outer = toBooleanValue(input.outer, true);
    const maxLength = clampInt(toNumberValue(input.maxLength, 30_000) ?? 30_000, 200, 500_000);

    let html = "";
    if (selector) {
      const picked = await pickLocator(page, selector, {
        timeoutMs: 8_000,
        requireVisible: false,
      });
      if (!picked.ok) {
        return {
          status: "error",
          note: picked.error,
          sessionId: session.session.id,
          currentUrl: safeUrl(page),
          received: input,
        };
      }
      html = await picked.locator.evaluate((element: Element, includeOuter: boolean) => {
        const el = element as HTMLElement;
        return includeOuter ? el.outerHTML : el.innerHTML;
      }, outer);
    } else {
      html = await page.content();
    }

    const clipped = clipText(html, maxLength);
    return {
      status: "ok",
      note: selector ? `html for ${selector}` : "html snapshot captured",
      sessionId: session.session.id,
      currentUrl: safeUrl(page),
      data: {
        selector: selector ?? null,
        truncated: clipped.truncated,
        totalLength: html.length,
        html: clipped.text,
      },
      received: input,
    };
  }

  async getText(input: ToolInput): Promise<BrowserToolOutput> {
    const session = this.requireSession(input);
    if (!session.ok) {
      return session.output;
    }

    const page = session.session.page;
    const selector = toStringValue(input.selector);
    const maxLength = clampInt(toNumberValue(input.maxLength, 16_000) ?? 16_000, 100, 300_000);

    let text = "";
    if (selector) {
      const picked = await pickLocator(page, selector, {
        timeoutMs: 8_000,
        requireVisible: false,
      });
      if (!picked.ok) {
        return {
          status: "error",
          note: picked.error,
          sessionId: session.session.id,
          currentUrl: safeUrl(page),
          received: input,
        };
      }

      if (picked.visible) {
        text = await picked.locator
          .innerText()
          .then((v: string) => v)
          .catch(() => "");
      } else {
        text = await picked.locator
          .textContent()
          .then((v: string | null) => v ?? "")
          .catch(() => "");
      }
    } else {
      text = await page.evaluate(() => document.body?.innerText ?? "");
    }

    text = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
    const clipped = clipText(text, maxLength);
    return {
      status: "ok",
      note: selector ? `text from ${selector}` : "page text captured",
      sessionId: session.session.id,
      currentUrl: safeUrl(page),
      data: {
        selector: selector ?? null,
        truncated: clipped.truncated,
        totalLength: text.length,
        text: clipped.text,
      },
      received: input,
    };
  }

  async find(input: ToolInput): Promise<BrowserToolOutput> {
    const session = this.requireSession(input);
    if (!session.ok) {
      return session.output;
    }

    const page = session.session.page;
    const selector = toStringValue(input.selector);
    const query = toStringValue(input.query);
    const limit = clampInt(toNumberValue(input.limit, 12) ?? 12, 1, 100);

    if (selector) {
      const locator = page.locator(selector);
      const count = await locator.count();
      const sampleCount = Math.min(limit, count);
      const samples: Array<{ index: number; text: string }> = [];
      for (let i = 0; i < sampleCount; i += 1) {
        const sampleText = await locator
          .nth(i)
          .innerText()
          .then((v: string) => v.replace(/\s+/g, " ").trim())
          .catch(() => "");
        samples.push({
          index: i,
          text: sampleText.slice(0, 200),
        });
      }

      return {
        status: "ok",
        note: `found ${count} node(s) for selector`,
        sessionId: session.session.id,
        currentUrl: safeUrl(page),
        data: {
          mode: "selector",
          selector,
          count,
          sample: samples,
        },
        received: input,
      };
    }

    if (!query) {
      return {
        status: "error",
        note: "provide selector or query",
        sessionId: session.session.id,
        currentUrl: safeUrl(page),
        received: input,
      };
    }

    const exact = toBooleanValue(input.exact, false);
    const caseSensitive = toBooleanValue(input.caseSensitive, false);
    const scopeSelector = toStringValue(input.scopeSelector);
    const matches = (await page.evaluate(
      ({
        needleRaw,
        exactMatch,
        isCaseSensitive,
        maxResults,
        scope,
      }: {
        needleRaw: string;
        exactMatch: boolean;
        isCaseSensitive: boolean;
        maxResults: number;
        scope?: string;
      }) => {
        const root = scope ? document.querySelector(scope) : document.body;
        if (!root) {
          return [] as Array<{ selector: string; tag: string; text: string }>;
        }

        const needle = isCaseSensitive ? needleRaw : needleRaw.toLowerCase();
        const results: Array<{ selector: string; tag: string; text: string }> = [];
        const elements = Array.from(root.querySelectorAll("*")) as Element[];
        for (const element of elements) {
          const style = window.getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden") {
            continue;
          }

          const text = (element.textContent || "").replace(/\s+/g, " ").trim();
          if (!text) {
            continue;
          }

          const hay = isCaseSensitive ? text : text.toLowerCase();
          const isMatch = exactMatch ? hay === needle : hay.includes(needle);
          if (!isMatch) {
            continue;
          }

          const tag = element.tagName.toLowerCase();
          const id = (element as HTMLElement).id;
          let selectorValue = tag;
          if (id) {
            selectorValue += `#${id}`;
          } else {
            const rawClassName = ((element as HTMLElement).className || "").toString().trim();
            if (rawClassName) {
              const splitParts = rawClassName.split(/\s+/);
              const classParts: string[] = [];
              for (let i = 0; i < splitParts.length; i += 1) {
                const item = splitParts[i];
                if (!item) {
                  continue;
                }
                classParts.push(item);
              }
              const selectedClasses: string[] = [];
              for (let i = 0; i < classParts.length && selectedClasses.length < 2; i += 1) {
                const part = classParts[i];
                if (!part) {
                  continue;
                }
                selectedClasses.push(`.${part}`);
              }
              selectorValue += selectedClasses.join("");
            }
          }

          results.push({
            selector: selectorValue,
            tag,
            text: text.slice(0, 220),
          });
          if (results.length >= maxResults) {
            break;
          }
        }

        return results;
      },
      {
        needleRaw: query,
        exactMatch: exact,
        isCaseSensitive: caseSensitive,
        maxResults: limit,
        scope: scopeSelector,
      },
    )) as Array<{ selector: string; tag: string; text: string }>;

    return {
      status: "ok",
      note: `found ${matches.length} text match(es)`,
      sessionId: session.session.id,
      currentUrl: safeUrl(page),
      data: {
        mode: "text",
        query,
        exact,
        caseSensitive,
        scopeSelector: scopeSelector ?? null,
        count: matches.length,
        matches,
      },
      received: input,
    };
  }

  async listLinks(input: ToolInput): Promise<BrowserToolOutput> {
    const session = this.requireSession(input);
    if (!session.ok) {
      return session.output;
    }

    const page = session.session.page;
    const limit = clampInt(toNumberValue(input.limit, 30) ?? 30, 1, 300);
    const contains = toStringValue(input.contains);
    const sameDomainOnly = toBooleanValue(input.sameDomainOnly, false);
    const currentUrl = safeUrl(page) ?? "";
    const currentHost = safeHostname(currentUrl);

    const links = (await page.evaluate(
      ({
        maxResults,
        containsText,
        currentHostValue,
        sameDomain,
      }: {
        maxResults: number;
        containsText?: string;
        currentHostValue?: string;
        sameDomain: boolean;
      }) => {
        const needle = containsText?.toLowerCase();
        const anchors = Array.from(document.querySelectorAll("a[href]"));
        const out: Array<{ text: string; href: string }> = [];
        for (const anchor of anchors) {
          const href = (anchor as HTMLAnchorElement).href || "";
          if (!href) {
            continue;
          }
          const text = ((anchor as HTMLAnchorElement).innerText || anchor.textContent || "")
            .replace(/\s+/g, " ")
            .trim();
          const checkBody = `${text} ${href}`.toLowerCase();
          if (needle && !checkBody.includes(needle)) {
            continue;
          }
          if (sameDomain && currentHostValue) {
            try {
              const host = new URL(href).hostname;
              if (host !== currentHostValue) {
                continue;
              }
            } catch {
              continue;
            }
          }

          out.push({
            text: text.slice(0, 180),
            href,
          });
          if (out.length >= maxResults) {
            break;
          }
        }
        return out;
      },
      {
        maxResults: limit,
        containsText: contains,
        currentHostValue: currentHost,
        sameDomain: sameDomainOnly,
      },
    )) as Array<{ text: string; href: string }>;

    return {
      status: "ok",
      note: `collected ${links.length} link(s)`,
      sessionId: session.session.id,
      currentUrl,
      data: {
        count: links.length,
        links,
      },
      received: input,
    };
  }

  async screenshot(input: ToolInput): Promise<BrowserToolOutput> {
    const session = this.requireSession(input);
    if (!session.ok) {
      return session.output;
    }

    const page = session.session.page;
    const fullPage = toBooleanValue(input.fullPage, true);
    const providedPath = toStringValue(input.path);
    const filePath = resolveScreenshotPath(providedPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await page.screenshot({ path: filePath, fullPage });

    return {
      status: "ok",
      note: `screenshot saved to ${filePath}`,
      sessionId: session.session.id,
      currentUrl: safeUrl(page),
      data: {
        path: filePath,
        fullPage,
      },
      received: input,
    };
  }

  private requireSession(input: ToolInput):
    | { ok: true; session: BrowserSession }
    | { ok: false; output: BrowserToolOutput } {
    if (!this.session) {
      return {
        ok: false,
        output: {
          status: "error",
          note: "no active browser. call create_browser first.",
          received: input,
        },
      };
    }
    return { ok: true, session: this.session };
  }

  private attachCleanupHooks(): void {
    if (this.cleanupHooksAttached) {
      return;
    }

    const close = async () => {
      await this.closeSession();
    };
    process.once("exit", () => {
      void close();
    });
    process.once("SIGINT", () => {
      void close();
    });
    process.once("SIGTERM", () => {
      void close();
    });
    this.cleanupHooksAttached = true;
  }
}

const browserManager = new HumanizedBrowserManager();

export const createBrowserTool: ToolDefinition<ToolInput, BrowserToolOutput> = {
  name: "create_browser",
  description: "create a fresh headless browser session and open url",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "target url to open after browser starts" },
      headless: { type: "boolean", description: "run browser in headless mode (default true)" },
      width: { type: "number", description: "viewport width in pixels" },
      height: { type: "number", description: "viewport height in pixels" },
      userAgent: { type: "string", description: "optional custom user-agent string" },
      timeoutMs: { type: "number", description: "navigation timeout in milliseconds" },
    },
    required: ["url"],
  },
  run: async (input: ToolInput) => ({
    ok: true,
    output: await browserManager.createSession(input),
  }),
};

export const closeBrowserTool: ToolDefinition<ToolInput, BrowserToolOutput> = {
  name: "close_browser",
  description: "close the current browser session",
  inputSchema: {
    type: "object",
    properties: {},
  },
  run: async () => ({
    ok: true,
    output: await browserManager.closeSession(),
  }),
};

export const clickTool: ToolDefinition<ToolInput, BrowserToolOutput> = {
  name: "click",
  description: "click an element using selector or coordinates with humanized mouse movement",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "css selector for click target" },
      x: { type: "number", description: "screen x coordinate" },
      y: { type: "number", description: "screen y coordinate" },
      button: { type: "string", description: "left/right/middle" },
    },
  },
  run: async (input: ToolInput) => ({
    ok: true,
    output: await browserManager.click(input),
  }),
};

export const dragTool: ToolDefinition<ToolInput, BrowserToolOutput> = {
  name: "drag",
  description: "drag from source to destination coordinates or selectors",
  inputSchema: {
    type: "object",
    properties: {
      fromSelector: { type: "string", description: "source selector" },
      toSelector: { type: "string", description: "destination selector" },
      fromX: { type: "number", description: "source x coordinate" },
      fromY: { type: "number", description: "source y coordinate" },
      toX: { type: "number", description: "destination x coordinate" },
      toY: { type: "number", description: "destination y coordinate" },
    },
  },
  run: async (input: ToolInput) => ({
    ok: true,
    output: await browserManager.drag(input),
  }),
};

export const scrollTool: ToolDefinition<ToolInput, BrowserToolOutput> = {
  name: "scroll",
  description: "scroll page by pixel delta or to a target selector",
  inputSchema: {
    type: "object",
    properties: {
      x: { type: "number", description: "horizontal scroll delta in pixels" },
      y: { type: "number", description: "vertical scroll delta in pixels" },
      target: { type: "string", description: "optional target selector to bring into view first" },
    },
  },
  run: async (input: ToolInput) => ({
    ok: true,
    output: await browserManager.scroll(input),
  }),
};

export const typeTool: ToolDefinition<ToolInput, BrowserToolOutput> = {
  name: "type",
  description: "type text with humanized timing into a focused field or selector",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "optional selector to focus first" },
      text: { type: "string", description: "text to type" },
      submit: { type: "boolean", description: "press enter after typing" },
      clear: { type: "boolean", description: "clear field content before typing" },
    },
    required: ["text"],
  },
  run: async (input: ToolInput) => ({
    ok: true,
    output: await browserManager.type(input),
  }),
};

export const waitTool: ToolDefinition<ToolInput, BrowserToolOutput> = {
  name: "wait",
  description: "wait for milliseconds or until an element becomes visible",
  inputSchema: {
    type: "object",
    properties: {
      ms: { type: "number", description: "time to wait in milliseconds" },
      selector: { type: "string", description: "selector to wait for visibility" },
      timeoutMs: { type: "number", description: "max wait time when waiting for selector" },
    },
  },
  run: async (input: ToolInput) => ({
    ok: true,
    output: await browserManager.wait(input),
  }),
};

export const navigateTool: ToolDefinition<ToolInput, BrowserToolOutput> = {
  name: "navigate",
  description: "navigate current page to a url",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "destination url" },
      timeoutMs: { type: "number", description: "navigation timeout in milliseconds" },
      waitUntil: { type: "string", description: "load | domcontentloaded | networkidle | commit" },
    },
    required: ["url"],
  },
  run: async (input: ToolInput) => ({
    ok: true,
    output: await browserManager.navigate(input),
  }),
};

export const reloadTool: ToolDefinition<ToolInput, BrowserToolOutput> = {
  name: "reload",
  description: "reload the current page",
  inputSchema: {
    type: "object",
    properties: {
      timeoutMs: { type: "number", description: "reload timeout in milliseconds" },
      waitUntil: { type: "string", description: "load | domcontentloaded | networkidle | commit" },
    },
  },
  run: async (input: ToolInput) => ({
    ok: true,
    output: await browserManager.reload(input),
  }),
};

export const goBackTool: ToolDefinition<ToolInput, BrowserToolOutput> = {
  name: "go_back",
  description: "navigate browser history backward",
  inputSchema: {
    type: "object",
    properties: {
      timeoutMs: { type: "number", description: "timeout in milliseconds" },
    },
  },
  run: async (input: ToolInput) => ({
    ok: true,
    output: await browserManager.goBack(input),
  }),
};

export const goForwardTool: ToolDefinition<ToolInput, BrowserToolOutput> = {
  name: "go_forward",
  description: "navigate browser history forward",
  inputSchema: {
    type: "object",
    properties: {
      timeoutMs: { type: "number", description: "timeout in milliseconds" },
    },
  },
  run: async (input: ToolInput) => ({
    ok: true,
    output: await browserManager.goForward(input),
  }),
};

export const hoverTool: ToolDefinition<ToolInput, BrowserToolOutput> = {
  name: "hover",
  description: "hover over an element using selector or coordinates",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "css selector for hover target" },
      x: { type: "number", description: "screen x coordinate" },
      y: { type: "number", description: "screen y coordinate" },
    },
  },
  run: async (input: ToolInput) => ({
    ok: true,
    output: await browserManager.hover(input),
  }),
};

export const pressKeyTool: ToolDefinition<ToolInput, BrowserToolOutput> = {
  name: "press_key",
  description: "press one keyboard key on the active page",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "key name, e.g. Enter, Tab, Escape, ArrowDown" },
      count: { type: "number", description: "optional repeat count" },
      delayMs: { type: "number", description: "optional per-key delay" },
    },
    required: ["key"],
  },
  run: async (input: ToolInput) => ({
    ok: true,
    output: await browserManager.pressKey(input),
  }),
};

export const pageInfoTool: ToolDefinition<ToolInput, BrowserToolOutput> = {
  name: "page_info",
  description: "get title, url, readiness, viewport and session metadata",
  inputSchema: {
    type: "object",
    properties: {},
  },
  run: async (input: ToolInput) => ({
    ok: true,
    output: await browserManager.getPageInfo(input),
  }),
};

export const getHtmlTool: ToolDefinition<ToolInput, BrowserToolOutput> = {
  name: "get_html",
  description: "read html for whole page or a selector",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "optional selector to scope html extraction" },
      outer: { type: "boolean", description: "when selector is used, return outerHTML (default true)" },
      maxLength: { type: "number", description: "maximum number of characters to return" },
    },
  },
  run: async (input: ToolInput) => ({
    ok: true,
    output: await browserManager.getHtml(input),
  }),
};

export const getTextTool: ToolDefinition<ToolInput, BrowserToolOutput> = {
  name: "get_text",
  description: "read visible text from page or selector",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "optional selector to scope text extraction" },
      maxLength: { type: "number", description: "maximum number of characters to return" },
    },
  },
  run: async (input: ToolInput) => ({
    ok: true,
    output: await browserManager.getText(input),
  }),
};

export const findTool: ToolDefinition<ToolInput, BrowserToolOutput> = {
  name: "find",
  description: "find elements by selector or search for text matches",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "selector mode: return matching nodes" },
      query: { type: "string", description: "text mode: search visible text" },
      scopeSelector: { type: "string", description: "optional scope element for text search" },
      exact: { type: "boolean", description: "text mode exact match" },
      caseSensitive: { type: "boolean", description: "text mode case-sensitive search" },
      limit: { type: "number", description: "max number of returned matches" },
    },
  },
  run: async (input: ToolInput) => ({
    ok: true,
    output: await browserManager.find(input),
  }),
};

export const listLinksTool: ToolDefinition<ToolInput, BrowserToolOutput> = {
  name: "list_links",
  description: "list links currently present on the page",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "maximum links to return" },
      contains: { type: "string", description: "filter by text or href substring" },
      sameDomainOnly: { type: "boolean", description: "only include links on current hostname" },
    },
  },
  run: async (input: ToolInput) => ({
    ok: true,
    output: await browserManager.listLinks(input),
  }),
};

export const screenshotTool: ToolDefinition<ToolInput, BrowserToolOutput> = {
  name: "screenshot",
  description: "take a screenshot of the current page",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "optional output path (png)" },
      fullPage: { type: "boolean", description: "capture full page (default true)" },
    },
  },
  run: async (input: ToolInput) => ({
    ok: true,
    output: await browserManager.screenshot(input),
  }),
};

export const BROWSER_BUILTIN_TOOLS: ToolDefinition[] = [
  createBrowserTool,
  closeBrowserTool,
  navigateTool,
  reloadTool,
  goBackTool,
  goForwardTool,
  pageInfoTool,
  getHtmlTool,
  getTextTool,
  findTool,
  listLinksTool,
  screenshotTool,
  hoverTool,
  pressKeyTool,
  clickTool,
  dragTool,
  scrollTool,
  typeTool,
  waitTool,
];

async function loadPlaywright(): Promise<{ ok: true; chromium: any } | { ok: false; error: string }> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<any>;
    const module = await dynamicImport("playwright");
    if (!module?.chromium) {
      return {
        ok: false,
        error: "playwright import succeeded, but chromium is unavailable",
      };
    }
    return { ok: true, chromium: module.chromium };
  } catch {
    return {
      ok: false,
      error: "playwright is not installed. run: npm install playwright",
    };
  }
}

async function resolveTargetPoint(
  page: any,
  input: ToolInput,
): Promise<{ ok: true; point: { x: number; y: number }; selector?: string } | { ok: false; error: string }> {
  const selector = toStringValue(input.selector);
  if (selector) {
    const picked = await pickLocator(page, selector, {
      timeoutMs: 8_000,
      requireVisible: true,
    });
    if (!picked.ok) {
      return { ok: false, error: picked.error };
    }
    await picked.locator.scrollIntoViewIfNeeded().catch(() => {});
    const box = await picked.locator.boundingBox();
    if (!box) {
      return { ok: false, error: `could not resolve bounding box for selector: ${selector}` };
    }

    const displaySelector = picked.count > 1 ? `${selector} [${picked.index + 1}/${picked.count}]` : selector;
    return {
      ok: true,
      point: {
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
      },
      selector: displaySelector,
    };
  }

  const x = toNumberValue(input.x);
  const y = toNumberValue(input.y);
  if (typeof x === "number" && typeof y === "number") {
    return {
      ok: true,
      point: { x, y },
    };
  }

  return {
    ok: false,
    error: "provide selector or both x and y",
  };
}

async function resolveDragPoint(
  page: any,
  input: ToolInput,
  side: "from" | "to",
): Promise<{ ok: true; point: { x: number; y: number } } | { ok: false; error: string }> {
  const selectorKey = side === "from" ? "fromSelector" : "toSelector";
  const xKey = side === "from" ? "fromX" : "toX";
  const yKey = side === "from" ? "fromY" : "toY";

  const selector = toStringValue(input[selectorKey]);
  if (selector) {
    const picked = await pickLocator(page, selector, {
      timeoutMs: 8_000,
      requireVisible: true,
    });
    if (!picked.ok) {
      return { ok: false, error: picked.error };
    }
    await picked.locator.scrollIntoViewIfNeeded().catch(() => {});
    const box = await picked.locator.boundingBox();
    if (!box) {
      return { ok: false, error: `could not resolve drag ${side} for selector: ${selector}` };
    }
    return {
      ok: true,
      point: {
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
      },
    };
  }

  const x = toNumberValue(input[xKey]);
  const y = toNumberValue(input[yKey]);
  if (typeof x === "number" && typeof y === "number") {
    return {
      ok: true,
      point: { x, y },
    };
  }

  return {
    ok: false,
    error: `provide ${selectorKey} or both ${xKey}/${yKey}`,
  };
}

async function pickLocator(
  page: any,
  selector: string,
  options?: {
    timeoutMs?: number;
    requireVisible?: boolean;
  },
): Promise<
  | {
      ok: true;
      locator: any;
      selector: string;
      count: number;
      index: number;
      visible: boolean;
    }
  | {
      ok: false;
      error: string;
      selector: string;
      count: number;
    }
> {
  const timeoutMs = options?.timeoutMs ?? 8_000;
  const requireVisible = options?.requireVisible ?? false;
  const locator = page.locator(selector);

  let count = await locator.count();
  if (count === 0) {
    await locator
      .first()
      .waitFor({ state: "attached", timeout: timeoutMs })
      .catch(() => {});
    count = await locator.count();
  }

  if (count === 0) {
    return {
      ok: false,
      error: `selector not found: ${selector}`,
      selector,
      count,
    };
  }

  const maxScan = Math.min(count, 60);
  for (let i = 0; i < maxScan; i += 1) {
    const candidate = locator.nth(i);
    const isVisible = await candidate.isVisible().catch(() => false);
    if (isVisible) {
      return {
        ok: true,
        locator: candidate,
        selector,
        count,
        index: i,
        visible: true,
      };
    }
  }

  if (requireVisible) {
    return {
      ok: false,
      error: `selector matched ${count} node(s), but none are visible: ${selector}`,
      selector,
      count,
    };
  }

  return {
    ok: true,
    locator: locator.first(),
    selector,
    count,
    index: 0,
    visible: false,
  };
}

async function moveMouseHumanized(
  page: any,
  from: { x: number; y: number },
  to: { x: number; y: number },
  customSteps?: number,
): Promise<void> {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = customSteps ?? clampInt(Math.round(distance / 11), 14, 46);
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const eased = easeInOut(t);
    const wiggle = (1 - t) * t;
    const jitterX = randomFloat(-1.6, 1.6) * wiggle;
    const jitterY = randomFloat(-1.6, 1.6) * wiggle;
    const x = from.x + (to.x - from.x) * eased + jitterX;
    const y = from.y + (to.y - from.y) * eased + jitterY;
    await page.mouse.move(x, y);
    await page.waitForTimeout(randomInt(5, 15));
  }
}

function easeInOut(t: number): number {
  return 0.5 * (1 - Math.cos(Math.PI * t));
}

function normalizeButton(value: string | undefined): "left" | "right" | "middle" {
  if (value === "right" || value === "middle") {
    return value;
  }
  return "left";
}

function toStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function toBooleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

function toNumberValue(value: unknown, fallback?: number): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function clampInt(value: number, min: number, max: number): number {
  const rounded = Math.round(value);
  return Math.min(max, Math.max(min, rounded));
}

function randomPick<T>(items: T[]): T {
  return items[randomInt(0, items.length - 1)]!;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function sanitizeForLog(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clipText(text: string, maxLength: number): { text: string; truncated: boolean } {
  if (text.length <= maxLength) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, Math.max(0, maxLength - 3))}...`,
    truncated: true,
  };
}

function normalizeWaitUntil(value: string | undefined): "load" | "domcontentloaded" | "networkidle" | "commit" {
  if (value === "load" || value === "domcontentloaded" || value === "networkidle" || value === "commit") {
    return value;
  }
  return "domcontentloaded";
}

function safeHostname(rawUrl: string): string | undefined {
  if (!rawUrl) {
    return undefined;
  }
  try {
    return new URL(rawUrl).hostname || undefined;
  } catch {
    return undefined;
  }
}

function resolveScreenshotPath(providedPath?: string): string {
  if (providedPath) {
    if (path.isAbsolute(providedPath)) {
      return providedPath;
    }
    return path.resolve(process.cwd(), providedPath);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.resolve(process.cwd(), "artifacts", `loaf-${stamp}.png`);
}

function safeUrl(page: any): string | undefined {
  try {
    return typeof page?.url === "function" ? page.url() : undefined;
  } catch {
    return undefined;
  }
}
