import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type {
  ComposerHealth,
  Confirmation,
  CursorWindow,
} from "@cursor-remote/shared";

export type SelectorPack = {
  name: string;
  cursorVersionHint?: string;
  chatInput: string[];
  sendButton: string[];
  chatListItem: string[];
  modelPickerButton: string[];
  modelOption: string[];
  messageBubble: string[];
  confirmationDialog: string[];
  confirmationButtons: string[];
};

function selectorsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dist = path.join(here, "selectors");
  if (fs.existsSync(dist)) return dist;
  return path.join(here, "..", "selectors");
}

export function loadSelectorPack(name = "default"): SelectorPack {
  const file = path.join(selectorsDir(), `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`selector pack not found: ${name}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as SelectorPack;
}

export class CdpDriver {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private targetId: string | null = null;
  private readonly locks = new Map<string, Promise<void>>();
  private lastDomFingerprint = "";

  constructor(
    private readonly cdpUrl: string,
    private selectors: SelectorPack,
  ) {}

  get selectorPackName(): string {
    return this.selectors.name;
  }

  reloadSelectors(name = "default"): void {
    this.selectors = loadSelectorPack(name);
  }

  async connect(): Promise<void> {
    await this.disconnect();
    this.browser = await puppeteer.connect({
      browserURL: this.cdpUrl,
      defaultViewport: null,
    });
  }

  async disconnect(): Promise<void> {
    if (this.browser) {
      try {
        this.browser.disconnect();
      } catch {
        // ignore
      }
    }
    this.browser = null;
    this.page = null;
    this.targetId = null;
  }

  async health(): Promise<ComposerHealth> {
    const issues: string[] = [];
    let cdpReachable = false;
    let windowCount = 0;
    let selectorsOk = false;
    let fixHint: string | undefined;

    try {
      const res = await fetch(`${this.cdpUrl}/json/version`);
      cdpReachable = res.ok;
      if (!cdpReachable) issues.push("CDP /json/version not ok");
    } catch (err) {
      issues.push(`CDP unreachable: ${(err as Error).message}`);
      fixHint =
        "Quit Cursor completely, then on the Mac run: ./scripts/launch-cursor-debug.sh — leave that window open. Daemon stays on :7843.";
    }

    if (cdpReachable) {
      try {
        if (!this.browser) await this.connect();
        const windows = await this.listWindows();
        windowCount = windows.length;
        if (windowCount === 0) {
          issues.push("no Cursor renderer targets found");
          fixHint =
            "Cursor is on debug port but no workbench page yet — open a project window.";
        }
        const page = await this.ensurePage(windows[0]?.targetId);
        if (page) {
          const found = await this.firstMatching(page, this.selectors.chatInput);
          selectorsOk = Boolean(found);
          if (!selectorsOk) {
            issues.push(
              "chat input selectors miss — update packages/daemon/selectors/default.json",
            );
            fixHint =
              "Open docs/selectors.md and retune selectors after a Cursor UI update.";
          }
        }
      } catch (err) {
        issues.push(`attach failed: ${(err as Error).message}`);
      }
    }

    return {
      cdpReachable,
      cdpUrl: this.cdpUrl,
      windowCount,
      selectorsOk,
      selectorPack: this.selectors.name,
      cursorVersionHint: this.selectors.cursorVersionHint,
      issues,
      fixHint,
    };
  }

  async listWindows(): Promise<CursorWindow[]> {
    if (!this.browser) await this.connect();
    const browser = this.browser!;
    const pages = await browser.pages();
    const out: CursorWindow[] = [];
    for (const [index, page] of pages.entries()) {
      const target = page.target();
      const type = target.type();
      if (type !== "page" && type !== "other") continue;
      const title = await page.title().catch(() => "");
      const url = page.url();
      const targetId = `${index}:${url}`;
      if (
        url.includes("vscode") ||
        url.includes("cursor") ||
        title.toLowerCase().includes("cursor") ||
        url.startsWith("vscode-file://") ||
        url.startsWith("vscode-app://") ||
        url === "about:blank"
      ) {
        out.push({ targetId, title: title || url, url, type });
      }
    }
    if (out.length === 0) {
      for (const [index, page] of pages.entries()) {
        const target = page.target();
        const url = page.url();
        out.push({
          targetId: `${index}:${url}`,
          title: (await page.title().catch(() => "")) || url,
          url,
          type: target.type(),
        });
      }
    }
    return out;
  }

  async selectWindow(targetId?: string): Promise<CursorWindow> {
    const windows = await this.listWindows();
    if (windows.length === 0) throw new Error("no Cursor windows");
    const chosen =
      (targetId && windows.find((w) => w.targetId === targetId)) || windows[0];
    await this.ensurePage(chosen.targetId);
    return chosen;
  }

  async sendMessage(text: string, submit = true): Promise<void> {
    const page = await this.ensurePage();
    await this.withLock(this.targetId || "default", async () => {
      const inputSel = await this.firstMatching(page, this.selectors.chatInput);
      if (!inputSel) {
        throw new Error("chat input not found — update selector pack");
      }
      await page.focus(inputSel);
      await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
      await page.keyboard.press("A");
      await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
      await page.keyboard.press("Backspace");

      // Paste as one clipboard payload so newlines never become Enter/queue splits.
      const pasted = await page.evaluate((value) => {
        const active = document.activeElement as HTMLElement | null;
        if (!active) return false;
        try {
          const dt = new DataTransfer();
          dt.setData("text/plain", value);
          const evt = new ClipboardEvent("paste", {
            clipboardData: dt,
            bubbles: true,
            cancelable: true,
          });
          active.dispatchEvent(evt);
          if (evt.defaultPrevented) return true;
        } catch {
          // fall through
        }
        try {
          return document.execCommand("insertText", false, value);
        } catch {
          return false;
        }
      }, text);

      if (!pasted) {
        // Last resort: type char-by-char but never send bare Enter (use Shift+Enter).
        for (const ch of text) {
          if (ch === "\n") {
            await page.keyboard.down("Shift");
            await page.keyboard.press("Enter");
            await page.keyboard.up("Shift");
          } else {
            await page.keyboard.sendCharacter(ch).catch(async () => {
              await page.keyboard.type(ch, { delay: 0 });
            });
          }
        }
      }

      if (submit) {
        const btn = await this.firstMatching(page, this.selectors.sendButton);
        if (btn) {
          await page.click(btn);
        } else {
          // Prefer chord that won't ambiguous-queue on some builds
          await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
          await page.keyboard.press("Enter");
          await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
        }
      }
    });
  }

  async selectChatByName(name: string): Promise<boolean> {
    const page = await this.ensurePage();
    return this.withLock(this.targetId || "default", async () => {
      const clicked = await page.evaluate(
        (selectors, chatName) => {
          for (const sel of selectors) {
            const nodes = Array.from(document.querySelectorAll(sel));
            for (const node of nodes) {
              const el = node as HTMLElement;
              if ((el.innerText || el.textContent || "").includes(chatName)) {
                el.click();
                return true;
              }
            }
          }
          // Broad fallback: click any clickable with matching text
          const all = Array.from(document.querySelectorAll("div,button,a,span"));
          for (const node of all) {
            const el = node as HTMLElement;
            const t = (el.innerText || "").trim();
            if (t === chatName || t.startsWith(chatName)) {
              el.click();
              return true;
            }
          }
          return false;
        },
        this.selectors.chatListItem,
        name,
      );
      return Boolean(clicked);
    });
  }

  /** Open the Composer model picker (parameters panel). */
  private async openModelPicker(page: Page): Promise<string | null> {
    const picker = await this.firstMatching(
      page,
      this.selectors.modelPickerButton,
    );
    if (!picker) return null;
    await page.keyboard.press("Escape").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 120));
    await page.click(picker);
    await new Promise((r) => setTimeout(r, 350));
    return picker;
  }

  /** Nested Model/Auto submenu — needs a real hover. */
  private async expandModelSubmenu(page: Page): Promise<void> {
    const submenuSels = [
      '[data-component="menu-submenu-trigger"]',
      ".ui-menu__submenu-trigger",
      '[role="menuitem"][aria-haspopup="menu"]',
    ];
    for (const sel of submenuSels) {
      const handle = await page.$(sel);
      if (!handle) continue;
      try {
        await handle.hover();
        await new Promise((r) => setTimeout(r, 200));
        await handle.click({ delay: 20 }).catch(() => undefined);
      } finally {
        await handle.dispose();
      }
      break;
    }
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const ready = await page.evaluate(() => {
        const names = document.querySelectorAll(
          ".ui-model-picker__item-content-name, [class*='model-picker__item-content-name']",
        ).length;
        const auto = Array.from(
          document.querySelectorAll('[role="menuitem"]'),
        ).some((n) =>
          /^auto$/i.test(
            ((n as HTMLElement).innerText || "").trim().split("\n")[0] || "",
          ),
        );
        return names > 0 || auto;
      });
      if (ready) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private async clickMenuItemByLabel(
    page: Page,
    label: string,
    opts?: { checkbox?: boolean; role?: string },
  ): Promise<boolean> {
    return page.evaluate(
      (wantRaw, checkbox, role) => {
        const normalize = (s: string) =>
          s
            .replace(/[\u200b-\u200d\ufeff]/g, "")
            .replace(/\s+/g, " ")
            .trim();
        const want = normalize(wantRaw).toLowerCase();
        const sel = role
          ? `[role="${role}"]`
          : checkbox
            ? '[role="menuitemcheckbox"]'
            : '[role="menuitem"],[role="menuitemradio"],[role="option"]';
        for (const node of Array.from(document.querySelectorAll(sel))) {
          const el = node as HTMLElement;
          const t = normalize(el.innerText || "").split("\n")[0] || "";
          if (t.toLowerCase() === want) {
            el.click();
            return true;
          }
        }
        return false;
      },
      label,
      Boolean(opts?.checkbox),
      opts?.role || "",
    );
  }

  private async clickModelInSubmenu(
    page: Page,
    modelLabel: string,
  ): Promise<boolean> {
    if (/^auto$/i.test(modelLabel.trim())) {
      return this.clickMenuItemByLabel(page, "Auto");
    }
    return page.evaluate((label) => {
      const normalize = (s: string) =>
        s
          .replace(/[\u200b-\u200d\ufeff]/g, "")
          .replace(/\s+/g, " ")
          .trim();
      const key = (s: string) =>
        normalize(s)
          .replace(
            /\b(extra\s*high|xhigh|high|medium|low|fast|max|no thinking)\b/gi,
            "",
          )
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      const want = key(label);
      const wantFull = normalize(label).toLowerCase();
      const items = Array.from(
        document.querySelectorAll(
          '[role="menuitem"],[role="menuitemradio"],.ui-model-picker__item-content-name',
        ),
      ) as HTMLElement[];
      const tryClick = (el: HTMLElement) => {
        const row =
          (el.closest(
            '[role="menuitem"],[role="menuitemradio"]',
          ) as HTMLElement | null) || el;
        row.click();
        return true;
      };
      for (const el of items) {
        const t = normalize(el.innerText || "").split("\n")[0] || "";
        if (!t || /^auto$/i.test(t)) continue;
        if (el.getAttribute("aria-haspopup") === "menu") continue;
        if (t.toLowerCase() === wantFull || key(t) === want) return tryClick(el);
      }
      for (const el of items) {
        const t = normalize(el.innerText || "").split("\n")[0] || "";
        if (!t || /^auto$/i.test(t)) continue;
        if (el.getAttribute("aria-haspopup") === "menu") continue;
        if (key(t).startsWith(want) || want.startsWith(key(t))) {
          return tryClick(el);
        }
      }
      return false;
    }, modelLabel);
  }

  /** Scrape Effort / Options / Context / etc from the open parameters panel. */
  private async scrapeParamsPanel(page: Page): Promise<{
    baseModel?: string;
    sections: Array<{
      id: string;
      title: string;
      kind: "choice" | "toggle";
      options: Array<{ id: string; label: string; selected: boolean }>;
    }>;
  }> {
    return page.evaluate(() => {
      const normalize = (s: string) =>
        s
          .replace(/[\u200b-\u200d\ufeff]/g, "")
          .replace(/\s+/g, " ")
          .trim();
      const slug = (s: string) =>
        normalize(s)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");

      const menus = Array.from(document.querySelectorAll('[role="menu"]'));
      const menu =
        menus.find((m) =>
          /parameters/i.test(m.getAttribute("aria-label") || ""),
        ) ||
        menus.find((m) =>
          /Effort|Options|Context|Thinking/i.test(
            (m as HTMLElement).innerText || "",
          ),
        );
      if (!menu) return { sections: [] };

      const sections: Array<{
        id: string;
        title: string;
        kind: "choice" | "toggle";
        options: Array<{ id: string; label: string; selected: boolean }>;
      }> = [];
      let baseModel: string | undefined;

      for (const group of Array.from(
        menu.querySelectorAll('[role="group"], .ui-menu__section'),
      )) {
        const title = normalize(
          (
            group.querySelector(
              '.ui-menu__section-title, [data-component="menu-section-title"]',
            ) as HTMLElement | null
          )?.innerText ||
            group.getAttribute("aria-label") ||
            "",
        );
        if (!title || /^model$/i.test(title)) {
          const trigger = group.querySelector(
            '[data-component="menu-submenu-trigger"],.ui-menu__submenu-trigger',
          ) as HTMLElement | null;
          if (trigger) {
            baseModel =
              normalize(trigger.innerText || "").split("\n")[0] || baseModel;
          }
          continue;
        }

        const toggles: Array<{ id: string; label: string; selected: boolean }> =
          [];
        const choices: Array<{ id: string; label: string; selected: boolean }> =
          [];

        for (const n of Array.from(
          group.querySelectorAll(
            '[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]',
          ),
        )) {
          const el = n as HTMLElement;
          if (el.getAttribute("aria-haspopup") === "menu") continue;
          const label = normalize(el.innerText || "").split("\n")[0] || "";
          if (!label || label.toLowerCase() === title.toLowerCase()) continue;
          const role = el.getAttribute("role") || "";
          if (role === "menuitemcheckbox") {
            toggles.push({
              id: slug(label),
              label,
              selected:
                el.getAttribute("aria-checked") === "true" ||
                el.getAttribute("data-checked") === "true",
            });
          } else {
            const right = el.querySelector(
              '[data-component="menu-item-right"]',
            );
            const selected = Boolean(
              right &&
                (right.querySelector("i, svg, [class*='check']") ||
                  (right.textContent || "").trim()),
            );
            choices.push({
              id: slug(label),
              label,
              selected,
            });
          }
        }

        if (toggles.length) {
          sections.push({
            id: slug(title) || "options",
            title,
            kind: "toggle",
            options: toggles,
          });
        }
        if (choices.length) {
          // If nothing marked selected, leave all false — client can still pick.
          sections.push({
            id: slug(title) || "choices",
            title,
            kind: "choice",
            options: choices,
          });
        }
      }

      return { baseModel, sections };
    });
  }

  async selectModel(
    modelLabel: string,
    effort?: string,
    fastMode?: boolean,
  ): Promise<boolean> {
    return this.applyModelConfig({
      modelLabel,
      choices: effort
        ? {
            Effort: /^(extra\s*high|xhigh)$/i.test(effort)
              ? "Extra High"
              : effort.replace(/^./, (c) => c.toUpperCase()),
          }
        : undefined,
      toggles: fastMode === undefined ? undefined : { Fast: fastMode },
    });
  }

  async applyModelConfig(config: {
    modelLabel: string;
    choices?: Record<string, string>;
    toggles?: Record<string, boolean>;
  }): Promise<boolean> {
    const page = await this.ensurePage();
    return this.withLock(this.targetId || "default", async () => {
      const picker = await this.openModelPicker(page);
      if (!picker) return false;

      const isAuto = /^auto$/i.test(config.modelLabel.trim());
      await this.expandModelSubmenu(page);
      const clicked = await this.clickModelInSubmenu(page, config.modelLabel);
      await page.keyboard.press("Escape").catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
      if (!clicked) return false;
      if (isAuto) return true;

      const choices = config.choices || {};
      const toggles = config.toggles || {};
      if (!Object.keys(choices).length && !Object.keys(toggles).length) {
        return true;
      }

      const again = await this.openModelPicker(page);
      if (!again) return true;

      for (const label of Object.values(choices)) {
        if (!label) continue;
        await this.clickMenuItemByLabel(page, label);
        await new Promise((r) => setTimeout(r, 120));
      }

      for (const [label, wantOn] of Object.entries(toggles)) {
        const current = await page.evaluate((name) => {
          const normalize = (s: string) =>
            s.replace(/[\u200b-\u200d\ufeff]/g, "").replace(/\s+/g, " ").trim();
          const el = Array.from(
            document.querySelectorAll('[role="menuitemcheckbox"]'),
          ).find(
            (n) =>
              normalize((n as HTMLElement).innerText || "").split("\n")[0] ===
              name,
          );
          if (!el) return null;
          return el.getAttribute("aria-checked") === "true";
        }, label);
        if (current == null) continue;
        if (current !== wantOn) {
          await this.clickMenuItemByLabel(page, label, { checkbox: true });
          await new Promise((r) => setTimeout(r, 120));
        }
      }

      await page.keyboard.press("Escape").catch(() => undefined);
      return true;
    });
  }

  /** List models; optionally include params for the currently selected model. */
  async listModelMenu(): Promise<{
    models: string[];
    current?: string;
    params?: {
      baseModel?: string;
      sections: Array<{
        id: string;
        title: string;
        kind: "choice" | "toggle";
        options: Array<{ id: string; label: string; selected: boolean }>;
      }>;
    };
  }> {
    const page = await this.ensurePage();
    return this.withLock(this.targetId || "default", async () => {
      const picker = await this.openModelPicker(page);
      if (!picker) {
        throw new Error(
          "model picker not found in Cursor UI — retune selectors",
        );
      }

      const currentParams = await this.scrapeParamsPanel(page);
      const triggerText = await page
        .$eval(picker, (el) =>
          ((el as HTMLElement).innerText || "").trim().split("\n")[0],
        )
        .catch(() => undefined);

      await this.expandModelSubmenu(page);

      const scraped = await page.evaluate(() => {
        const normalize = (s: string) =>
          s
            .replace(/[\u200b-\u200d\ufeff]/g, "")
            .replace(/\s+/g, " ")
            .trim();
        const noise = new Set(
          [
            "close",
            "cancel",
            "done",
            "settings",
            "add model",
            "add models",
            "manage models",
            "search",
            "max mode",
            "context",
            "thinking",
            "model",
            "customize",
            "automations",
            "new chat",
            "ultra plan",
            "pro plan",
            "business plan",
            "low",
            "medium",
            "high",
            "extra high",
            "max",
            "fast",
            "effort",
            "options",
            "300k",
            "1m",
          ].map((s) => s.toLowerCase()),
        );
        const pushUnique = (arr: string[], raw: string) => {
          const s = normalize(raw);
          if (!s || s.length > 90) return;
          const lower = s.toLowerCase();
          if (noise.has(lower)) return;
          if (/^⌘/.test(s) || /^\d+m$/i.test(s) || /^\d+k$/i.test(s)) return;
          if (/recommended for most tasks/i.test(s)) return;
          if (arr.some((x) => x.toLowerCase() === lower)) return;
          arr.push(s);
        };
        const models: string[] = [];
        const hasAuto = Array.from(
          document.querySelectorAll('[role="menuitem"]'),
        ).some((n) =>
          /^auto$/i.test(
            normalize((n as HTMLElement).innerText || "").split("\n")[0] || "",
          ),
        );
        if (hasAuto) models.push("Auto");

        const nameNodes = Array.from(
          document.querySelectorAll(
            ".ui-model-picker__item-content-name, [class*='model-picker__item-content-name']",
          ),
        ) as HTMLElement[];
        for (const el of nameNodes) {
          pushUnique(models, el.innerText || el.textContent || "");
        }
        if (models.filter((m) => !/^auto$/i.test(m)).length === 0) {
          for (const node of Array.from(
            document.querySelectorAll('[role="menuitem"]'),
          )) {
            const el = node as HTMLElement;
            if (el.getAttribute("aria-haspopup") === "menu") continue;
            const first = normalize(el.innerText || "").split("\n")[0] || "";
            if (first) pushUnique(models, first);
          }
        }
        return { models };
      });

      await page.keyboard.press("Escape");
      await new Promise((r) => setTimeout(r, 150));

      const current =
        currentParams.baseModel && triggerText
          ? triggerText
          : currentParams.baseModel || triggerText;

      return {
        models: scraped.models,
        current,
        params: {
          baseModel: currentParams.baseModel,
          sections: currentParams.sections,
        },
      };
    });
  }

  /** Select a model (if given) then return its live parameter sections. */
  async getModelParams(modelLabel?: string): Promise<{
    modelLabel: string;
    baseModel?: string;
    sections: Array<{
      id: string;
      title: string;
      kind: "choice" | "toggle";
      options: Array<{ id: string; label: string; selected: boolean }>;
    }>;
  }> {
    const page = await this.ensurePage();
    return this.withLock(this.targetId || "default", async () => {
      if (modelLabel && !/^auto$/i.test(modelLabel.trim())) {
        const picker = await this.openModelPicker(page);
        if (!picker) throw new Error("model picker not found");
        await this.expandModelSubmenu(page);
        const ok = await this.clickModelInSubmenu(page, modelLabel);
        await page.keyboard.press("Escape").catch(() => undefined);
        await new Promise((r) => setTimeout(r, 250));
        if (!ok) throw new Error(`could not select model: ${modelLabel}`);
      } else if (modelLabel && /^auto$/i.test(modelLabel.trim())) {
        const picker = await this.openModelPicker(page);
        if (!picker) throw new Error("model picker not found");
        await this.expandModelSubmenu(page);
        await this.clickModelInSubmenu(page, "Auto");
        await page.keyboard.press("Escape").catch(() => undefined);
        await new Promise((r) => setTimeout(r, 250));
        return { modelLabel: "Auto", sections: [] };
      }

      const picker = await this.openModelPicker(page);
      if (!picker) throw new Error("model picker not found");
      const triggerText = await page
        .$eval(picker, (el) =>
          ((el as HTMLElement).innerText || "").trim().split("\n")[0],
        )
        .catch(() => modelLabel || "unknown");
      const scraped = await this.scrapeParamsPanel(page);
      await page.keyboard.press("Escape").catch(() => undefined);
      return {
        modelLabel: triggerText || modelLabel || scraped.baseModel || "unknown",
        baseModel: scraped.baseModel,
        sections: scraped.sections,
      };
    });
  }

  /** @deprecated use listModelMenu */
  async listModelLabels(): Promise<string[]> {
    const menu = await this.listModelMenu();
    return menu.models;
  }

  async pollDomEvents(): Promise<{ kind: string; text?: string } | null> {
    const page = await this.ensurePage();
    const snapshot = await page.evaluate((selectors) => {
      const parts: string[] = [];
      for (const sel of selectors) {
        for (const node of Array.from(document.querySelectorAll(sel))) {
          const t = ((node as HTMLElement).innerText || "").trim();
          if (t) parts.push(t.slice(-500));
        }
      }
      return parts.slice(-5).join("\n---\n");
    }, this.selectors.messageBubble);
    if (snapshot && snapshot !== this.lastDomFingerprint) {
      this.lastDomFingerprint = snapshot;
      return { kind: "dom_update", text: snapshot };
    }
    return null;
  }

  /** Live agent status lines from Composer UI (Thinking…, Planning next moves…). */
  async scrapeAgentActivity(): Promise<{
    status?: string;
    labels: string[];
    currentModel?: string;
  }> {
    const page = await this.ensurePage();
    return page.evaluate(() => {
      const labels: string[] = [];
      const push = (raw: string) => {
        const s = raw.replace(/\s+/g, " ").trim().split("·")[0].trim();
        if (!s || s.length > 60) return;
        if (labels.some((x) => x.toLowerCase() === s.toLowerCase())) return;
        labels.push(s);
      };

      const roots = Array.from(
        document.querySelectorAll(
          ".agent-transcript-row-activity, .ui-step-group-collapsible, [class*='agent-transcript-activity']",
        ),
      ) as HTMLElement[];

      for (const el of roots) {
        const first = (el.innerText || "").trim().split("\n")[0] || "";
        if (
          /^(Thinking|Planning|Exploring|Explored|Making edits|Running|Reading|Searching|Grepped|Thought|Editing)\b/i.test(
            first,
          )
        ) {
          push(first);
        }
      }

      for (const el of Array.from(
        document.querySelectorAll(
          "[class*='generating'], [class*='spinner'], [aria-label*='Thinking'], [aria-label*='Planning']",
        ),
      )) {
        const t =
          (el as HTMLElement).getAttribute("aria-label") ||
          ((el as HTMLElement).innerText || "").trim().split("\n")[0];
        if (t) push(t);
      }

      const priority = [
        /^Thinking/i,
        /^Planning/i,
        /^Making edits/i,
        /^Exploring/i,
        /^Running/i,
      ];
      let status: string | undefined;
      for (const re of priority) {
        status = [...labels].reverse().find((l) => re.test(l));
        if (status) break;
      }
      if (!status) status = labels[labels.length - 1];

      const trigger = document.querySelector(
        ".ui-model-picker__trigger, button:has(.ui-model-picker__trigger-text)",
      ) as HTMLElement | null;
      const currentModel = (trigger?.innerText || "")
        .replace(/[\u200b-\u200d\ufeff]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .split("\n")[0];

      return {
        status,
        labels: labels.slice(-10),
        currentModel: currentModel || undefined,
      };
    });
  }

  async listConfirmations(): Promise<Confirmation[]> {
    const page = await this.ensurePage();
    const items = await page.evaluate(
      (dialogSels, buttonSels) => {
        const out: Array<{
          id: string;
          text: string;
          actions: Array<{ id: string; label: string; risk: string }>;
        }> = [];
        for (const sel of dialogSels) {
          for (const dialog of Array.from(document.querySelectorAll(sel))) {
            const text = ((dialog as HTMLElement).innerText || "").trim();
            if (!text) continue;
            const actions: Array<{ id: string; label: string; risk: string }> =
              [];
            for (const bsel of buttonSels) {
              for (const btn of Array.from(dialog.querySelectorAll(bsel))) {
                const label = ((btn as HTMLElement).innerText || "").trim();
                if (!label) continue;
                const lower = label.toLowerCase();
                const risk =
                  lower.includes("delete") ||
                  lower.includes("overwrite") ||
                  lower.includes("force")
                    ? "high"
                    : lower.includes("allow") || lower.includes("run")
                      ? "medium"
                      : "low";
                actions.push({
                  id: `${actions.length}:${label}`,
                  label,
                  risk,
                });
              }
            }
            out.push({
              id: `dlg-${out.length}`,
              text: text.slice(0, 500),
              actions: actions as Array<{
                id: string;
                label: string;
                risk: "low" | "medium" | "high";
              }>,
            });
          }
        }
        return out;
      },
      this.selectors.confirmationDialog,
      this.selectors.confirmationButtons,
    );
    return items as Confirmation[];
  }

  async actOnConfirmation(
    confirmationId: string,
    actionId: string,
  ): Promise<boolean> {
    const confirmations = await this.listConfirmations();
    const conf = confirmations.find((c) => c.id === confirmationId);
    if (!conf) return false;
    const action = conf.actions.find((a) => a.id === actionId);
    if (!action) return false;
    const page = await this.ensurePage();
    return page.evaluate((label) => {
      const buttons = Array.from(document.querySelectorAll("button"));
      for (const btn of buttons) {
        if ((btn.innerText || "").trim() === label) {
          btn.click();
          return true;
        }
      }
      return false;
    }, action.label);
  }

  private async ensurePage(targetId?: string): Promise<Page> {
    if (!this.browser) await this.connect();
    const browser = this.browser!;
    if (targetId && this.targetId === targetId && this.page) return this.page;

    const pages = await browser.pages();
    let page: Page | undefined;
    if (targetId?.includes(":")) {
      const index = Number(targetId.split(":")[0]);
      if (!Number.isNaN(index)) page = pages[index];
    }
    if (!page) {
      for (const p of pages) {
        const url = p.url();
        if (url.includes("vscode") || url.includes("workbench")) {
          page = p;
          break;
        }
      }
    }
    page = page || pages[0];
    if (!page) throw new Error("no page targets");
    this.page = page;
    const idx = pages.indexOf(page);
    this.targetId = targetId || `${idx}:${page.url()}`;
    return page;
  }

  private async firstMatching(
    page: Page,
    selectors: string[],
  ): Promise<string | null> {
    for (const sel of selectors) {
      const handle = await page.$(sel);
      if (handle) {
        await handle.dispose();
        return sel;
      }
    }
    return null;
  }

  private async withLock<T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.locks.get(key) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    this.locks.set(
      key,
      prev.then(() => gate),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
