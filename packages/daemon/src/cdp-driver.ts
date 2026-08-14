import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type {
  ComposerHealth,
  Confirmation,
  CursorWindow,
} from "@cursor-remote/shared";
import { activateCursorApp } from "./open-cursor.js";

export type SelectorPack = {
  name: string;
  cursorVersionHint?: string;
  chatInput: string[];
  sendButton: string[];
  chatListItem: string[];
  agentsPanel?: string[];
  agentsRepoRow?: string[];
  agentsChatRow?: string[];
  agentsActivityButton?: string[];
  modelPickerButton: string[];
  modelOption: string[];
  messageBubble: string[];
  confirmationDialog: string[];
  confirmationButtons: string[];
  newChatButton?: string[];
  stopButton?: string[];
};

export type SelectComposerOpts = {
  targetId?: string;
  chatId?: string;
  chatName?: string;
  projectPath?: string;
  projectName?: string;
  /** When true, skip OS activate (already done by caller). */
  skipActivate?: boolean;
  /**
   * When true, click the Agents → Repositories left panel to switch
   * project/chat (never Open Recent, never spawn).
   */
  switchIfNeeded?: boolean;
  /** Refuse fallback to unrelated windows when a project was requested. */
  requireProjectMatch?: boolean;
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
    await this.activateCurrentPage();
    return chosen;
  }

/**
   * Bind to a project/chat via the Agents → Repositories left panel.
   * Never uses Open Recent and never types into the Composer input.
   */
  async selectComposerContext(
    opts: SelectComposerOpts = {},
  ): Promise<{
    window: CursorWindow;
    chatSelected: boolean;
    matchedBy: "targetId" | "project" | "agentsPanel" | "fallback";
    repoSelected?: boolean;
  }> {
    if (!opts.skipActivate) {
      await activateCursorApp();
    }
    const windows = await this.listWindows();
    if (windows.length === 0) {
      throw new Error(
        "no Cursor windows — open Cursor with CDP debugging on the host",
      );
    }

    let matchedBy: "targetId" | "project" | "agentsPanel" | "fallback" =
      "fallback";
    let chosen: CursorWindow | undefined;

    if (opts.targetId) {
      chosen = windows.find((w) => w.targetId === opts.targetId);
      if (chosen) matchedBy = "targetId";
    }

    // Prefer a window whose title already mentions the project (multi-window setups).
    if (!chosen && (opts.projectPath || opts.projectName)) {
      chosen = this.matchWindowForProject(
        windows,
        opts.projectPath,
        opts.projectName,
      );
      if (chosen) matchedBy = "project";
    }

    if (!chosen) {
      chosen = windows[0];
      matchedBy = "fallback";
    }

    await this.ensurePage(chosen.targetId);
    await this.activateCurrentPage();

    let chatSelected = false;
    let repoSelected = false;

    if (opts.projectName || opts.projectPath || opts.chatName || opts.chatId) {
      const panel = await this.selectInAgentsPanel({
        projectPath: opts.projectPath,
        projectName: opts.projectName,
        chatName: opts.chatName,
        chatId: opts.chatId,
      });
      repoSelected = panel.repoSelected;
      chatSelected = panel.chatSelected;
      if (panel.ok) {
        matchedBy = "agentsPanel";
      } else if (
        opts.requireProjectMatch &&
        (opts.projectPath || opts.projectName) &&
        !panel.repoSelected
      ) {
        throw new Error(
          panel.message ||
            `Could not find "${opts.projectName || opts.projectPath}" in the Agents → Repositories panel. Open the Agents sidebar in Cursor and retry.`,
        );
      }
    }

    return { window: chosen, chatSelected, matchedBy, repoSelected };
  }

/**
   * Bind a project/chat in Cursor's Agents → Repositories sidebar.
   *
   * Real fix: Cursor 3.15+ renders the Repositories sidebar with one
   * "featured" chat per repo (see `initialMaxVisible: 1` on component
   * `OFk`), so clicking sidebar rows can only reach that one chat.
   * The composer pane can host any chat regardless of what the sidebar
   * shows. To open an arbitrary chat by id we call `onSelectAgent(id)`
   * on the sidebar React fiber (`vBk`) which switches the composer
   * regardless of virtualization / whether the row is even mounted.
   */
  async selectInAgentsPanel(opts: {
    projectPath?: string;
    projectName?: string;
    chatName?: string;
    chatId?: string;
  }): Promise<{
    ok: boolean;
    repoSelected: boolean;
    chatSelected: boolean;
    message?: string;
  }> {
    const page = await this.ensurePage();
    await this.activateCurrentPage();

    await page
      .evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        active?.blur?.();
      })
      .catch(() => undefined);

    await this.ensureAgentsPanelVisible(page);

    const projectKeys = [
      opts.projectName,
      opts.projectPath
        ? path.basename(opts.projectPath.replace(/[\\/]+$/, ""))
        : undefined,
      opts.projectPath,
    ]
      .filter((s): s is string => Boolean(s && s.trim()))
      .map((s) => s.trim());

    const chatName = opts.chatName?.trim() || "";
    const chatId = opts.chatId?.trim() || "";

    // Fast path — invoke Cursor's own `onSelectAgent(id)` via React fiber.
    // Works even when the chat row isn't rendered in the sidebar
    // (Repositories view only ever shows one featured chat per repo).
    if (chatId) {
      const fiber = await this.selectAgentByFiber(page, chatId);
      if (fiber.ok) {
        return {
          ok: true,
          repoSelected: true,
          chatSelected: true,
          message: fiber.message || "selected-by-fiber",
        };
      }
    }

    // Fallback: composer id in the DOM (rare — Cursor no longer uses
    // data-composer-id, kept for older builds / selector overrides).
    if (chatId && (await this.clickComposerId(page, chatId))) {
      await new Promise((r) => setTimeout(r, 350));
      return {
        ok: true,
        repoSelected: true,
        chatSelected: true,
        message: "clicked-by-id",
      };
    }

    // Expand the matching repository (chevron only when collapsed).
    const expanded = await page.evaluate((keys) => {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
      const labelOf = (el: HTMLElement) => {
        const raw = (el.innerText || el.textContent || "").trim();
        const line = (raw.split("\n")[0] || raw).replace(/\b\d+[smhdwy]\b/gi, "");
        return norm(line);
      };
      const needles = keys.map(norm).filter(Boolean);

      const panel = (() => {
        for (const el of Array.from(
          document.querySelectorAll("div,span,h1,h2,h3"),
        ) as HTMLElement[]) {
          if (labelOf(el) !== "repositories") continue;
          let p: HTMLElement | null = el;
          for (let i = 0; i < 10 && p; i++) {
            if ((p.innerText || "").length > 60) return p;
            p = p.parentElement;
          }
        }
        return document.body;
      })();

      let best: HTMLElement | null = null;
      let bestScore = 0;
      for (const el of Array.from(
        panel.querySelectorAll(
          "[role='treeitem'],[role='option'],[role='listitem'],div,button,a,li,span",
        ),
      ) as HTMLElement[]) {
        const t = labelOf(el);
        if (!t || t.length > 80 || t === "repositories") continue;
        for (const n of needles) {
          let score = 0;
          if (t === n) score = 100;
          else if (t.endsWith("/" + n)) score = 80;
          else if (t.includes(n) && t.length <= n.length + 24) score = 40;
          if (score > bestScore) {
            bestScore = score;
            best = el;
          }
        }
      }
      if (!best) return { ok: false as const, message: "repo not found" };

      const row =
        (best.closest(
          "[role='treeitem'],[role='option'],[role='listitem']",
        ) as HTMLElement | null) || best;

      const aria =
        row.getAttribute("aria-expanded") ||
        row.closest("[aria-expanded]")?.getAttribute("aria-expanded");
      const parentText = (row.parentElement?.innerText || row.innerText || "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const alreadyOpen = aria === "true" || (aria !== "false" && parentText.length >= 2);

      row.scrollIntoView({ block: "nearest" });
      if (!alreadyOpen) {
        const expander = row.querySelector(
          "[aria-label*='expand' i],.codicon-chevron-right,[class*='chevron'],[class*='twistie']",
        ) as HTMLElement | null;
        (expander || row).click();
      }
      return { ok: true as const, alreadyOpen };
    }, projectKeys);

    if (!expanded.ok && projectKeys.length) {
      return {
        ok: false,
        repoSelected: false,
        chatSelected: false,
        message: `repo not found in Agents panel: ${projectKeys[0]}`,
      };
    }

    await new Promise((r) => setTimeout(r, 500));

    if (!chatName && !chatId) {
      return { ok: true, repoSelected: true, chatSelected: false };
    }

    // After expand, prefer composer id again.
    if (chatId && (await this.clickComposerId(page, chatId))) {
      await new Promise((r) => setTimeout(r, 350));
      return {
        ok: true,
        repoSelected: true,
        chatSelected: true,
        message: "clicked-by-id-after-expand",
      };
    }

    // Name-based click with real mouse coordinates (React often ignores el.click()).
    const box = await page.evaluate((args) => {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
      const labelOf = (el: HTMLElement) => {
        const raw = (el.innerText || el.textContent || "").trim();
        const line =
          raw
            .split("\n")
            .map((l) => l.replace(/\b\d+[smhdwy]\b/gi, "").trim())
            .filter(Boolean)[0] || raw;
        return norm(line.replace(/\b\d+[smhdwy]\b/gi, ""));
      };
      const needles = args.projectKeys.map(norm).filter(Boolean);
      const want = norm(args.chatName);
      const isRepo = (t: string) =>
        needles.some((n) => t === n || t.endsWith("/" + n));

      const panel = (() => {
        for (const el of Array.from(
          document.querySelectorAll("div,span,h1,h2,h3"),
        ) as HTMLElement[]) {
          if (labelOf(el) !== "repositories") continue;
          let p: HTMLElement | null = el;
          for (let i = 0; i < 10 && p; i++) {
            if ((p.innerText || "").length > 60) return p;
            p = p.parentElement;
          }
        }
        return document.body;
      })();

      type Row = { el: HTMLElement; label: string; top: number; left: number };
      const rows: Row[] = [];
      for (const el of Array.from(
        panel.querySelectorAll(
          "[role='treeitem'],[role='option'],[role='listitem'],[data-composer-id],button,a,div,span",
        ),
      ) as HTMLElement[]) {
        const label = labelOf(el);
        if (!label || label.length > 120 || label === "repositories") continue;
        const rect = el.getBoundingClientRect();
        if (rect.height < 10 || rect.width < 30) continue;
        rows.push({ el, label, top: rect.top, left: rect.left });
      }
      rows.sort((a, b) => a.top - b.top || a.left - b.left);

      let repoIdx = rows.findIndex((r) => isRepo(r.label));
      const start = repoIdx >= 0 ? repoIdx + 1 : 0;
      let end = rows.length;
      for (let i = start; i < rows.length; i++) {
        if (isRepo(rows[i].label)) {
          end = i;
          break;
        }
      }
      const pool = rows.slice(start, end);

      let best: Row | null = null;
      let bestScore = 0;
      for (const row of pool.length ? pool : rows) {
        if (isRepo(row.label)) continue;
        let score = 0;
        if (row.label === want) score = 1000;
        else if (row.label.startsWith(want)) score = 800;
        else if (want.startsWith(row.label) && row.label.length > 3) score = 600;
        else if (row.label.includes(want)) score = 400;
        else if (want.includes(row.label) && row.label.length > 5) score = 300;
        if (row.el.hasAttribute("data-composer-id")) score += 80;
        // Prefer deeper/leaf nodes (smaller height often = title row)
        score += Math.max(0, 40 - Math.min(40, row.el.getBoundingClientRect().height / 2));
        if (score > bestScore) {
          bestScore = score;
          best = row;
        }
      }
      if (!best || bestScore < 300) return null;

      let target = best.el;
      const withId = best.el.closest("[data-composer-id]") as HTMLElement | null;
      if (withId) target = withId;
      else {
        const row = best.el.closest(
          "[role='treeitem'],[role='option'],button,a",
        ) as HTMLElement | null;
        if (row) target = row;
      }
      target.setAttribute("data-cursor-remote-click", "1");
      const rect = target.getBoundingClientRect();
      return {
        x: rect.left + Math.min(rect.width * 0.4, 120),
        y: rect.top + rect.height / 2,
        label: best.label,
      };
    }, { projectKeys, chatName });

    if (!box) {
      return {
        ok: false,
        repoSelected: Boolean(expanded.ok),
        chatSelected: false,
        message: `chat not found under repo: ${chatName || chatId}`,
      };
    }

    await page.mouse.click(box.x, box.y, { delay: 40 });
    await new Promise((r) => setTimeout(r, 200));
    // Second click helps some list virtualizers commit selection
    await page.mouse.click(box.x, box.y, { delay: 20 });
    await new Promise((r) => setTimeout(r, 350));

    // Clear marker
    await page
      .evaluate(() => {
        document
          .querySelectorAll("[data-cursor-remote-click]")
          .forEach((n) => n.removeAttribute("data-cursor-remote-click"));
      })
      .catch(() => undefined);

    return {
      ok: true,
      repoSelected: true,
      chatSelected: true,
      message: `clicked:${box.label}`,
    };
  }

  /**
   * Call Cursor's internal `onSelectAgent(id)` React handler via fiber
   * traversal. This is how Cursor itself switches composers when the
   * user clicks a row, and it works for any chat id (including ones
   * that are not currently rendered in the Repositories sidebar).
   *
   * Verifies the switch by polling
   * `window.__cursorComposerVirtualizationDebug.getSnapshot().composerId`.
   */
  private async selectAgentByFiber(
    page: Page,
    chatId: string,
  ): Promise<{ ok: boolean; message?: string }> {
    // Give React a moment to mount if the panel just opened.
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await page.evaluate(
        async (agentId): Promise<{ found: boolean; result?: string; err?: string }> => {
          type Fiber = {
            pendingProps?: Record<string, unknown> | null;
            memoizedProps?: Record<string, unknown> | null;
            return?: Fiber | null;
          };
          const getFiber = (el: Element | null): Fiber | null => {
            if (!el) return null;
            const key = Object.keys(el).find((k) =>
              k.startsWith("__reactFiber$"),
            );
            return key ? ((el as unknown as Record<string, Fiber>)[key] ?? null) : null;
          };
          const anchors: (Element | null)[] = [
            document.querySelector("li.ui-sidebar-menu-item"),
            document.querySelector("[data-agent-drop-section-id]"),
            document.querySelector("[data-sidebar-group]"),
            document.querySelector("[data-sidebar-root]"),
            document.body,
          ];
          for (const anchor of anchors) {
            const start = getFiber(anchor);
            if (!start) continue;
            let node: Fiber | null | undefined = start;
            for (let i = 0; i < 250 && node; i++) {
              const props = node.memoizedProps || node.pendingProps || null;
              const fn = props?.onSelectAgent;
              if (typeof fn === "function") {
                try {
                  const out = await (fn as (
                    id: string,
                    opts: { preserveActiveAgent?: boolean },
                  ) => unknown)(agentId, { preserveActiveAgent: false });
                  return { found: true, result: String(out) };
                } catch (err) {
                  return { found: true, err: (err as Error).message };
                }
              }
              node = node.return;
            }
          }
          return { found: false };
        },
        chatId,
      );
      if (res.err) return { ok: false, message: `onSelectAgent threw: ${res.err}` };
      if (res.found) {
        // Poll for the composer swap to land (Cursor loads the chat async).
        const deadline = Date.now() + 2500;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
          const open = await page
            .evaluate(() => {
              const w = window as unknown as {
                __cursorComposerVirtualizationDebug?: {
                  getSnapshot?: () => { composerId?: string } | undefined;
                };
              };
              return w.__cursorComposerVirtualizationDebug?.getSnapshot?.()
                ?.composerId;
            })
            .catch(() => undefined);
          if (open === chatId) {
            return { ok: true, message: `fiber:${res.result || "ok"}` };
          }
        }
        // Cursor accepted the call but never landed on the chat — likely
        // because the composer is currently generating on another chat
        // and Cursor refuses to swap. Report so callers can retry later.
        return {
          ok: false,
          message: "onSelectAgent invoked but composer did not switch",
        };
      }
      // Fiber not mounted yet — wait and retry
      await new Promise((r) => setTimeout(r, 200));
    }
    return { ok: false, message: "onSelectAgent handler not found on fiber tree" };
  }

  /** Click a chat row by Cursor composer id attribute(s). */
  private async clickComposerId(page: Page, chatId: string): Promise<boolean> {
    const found = await page.evaluate((id) => {
      const candidates: HTMLElement[] = [];
      const push = (el: Element | null) => {
        if (el && el instanceof HTMLElement) candidates.push(el);
      };
      push(document.querySelector(`[data-composer-id="${id}"]`));
      push(document.querySelector(`[data-composerid="${id}"]`));
      push(document.querySelector(`[data-id="${id}"]`));
      for (const el of Array.from(document.querySelectorAll("*"))) {
        if (!(el instanceof HTMLElement)) continue;
        for (const attr of Array.from(el.attributes)) {
          if (attr.value === id) {
            candidates.push(el);
            break;
          }
        }
      }
      const el = candidates[0];
      if (!el) return null;
      const target =
        (el.closest(
          "[data-composer-id],button,a,[role='treeitem'],[role='option']",
        ) as HTMLElement | null) || el;
      target.scrollIntoView({ block: "nearest" });
      const rect = target.getBoundingClientRect();
      return {
        x: rect.left + Math.min(rect.width * 0.4, 120),
        y: rect.top + rect.height / 2,
      };
    }, chatId);

    if (!found) return false;
    await page.mouse.click(found.x, found.y, { delay: 40 });
    await new Promise((r) => setTimeout(r, 150));
    await page.mouse.click(found.x, found.y, { delay: 20 });
    return true;
  }

  private async ensureAgentsPanelVisible(page: Page): Promise<void> {
    const hasRepos = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("div,span,h1,h2,h3"));
      return nodes.some((n) =>
        /^repositories$/i.test(
          ((n as HTMLElement).innerText || "").trim().split("\n")[0] || "",
        ),
      );
    });
    if (hasRepos) return;

    const sels = this.selectors.agentsActivityButton || [];
    const btn = await this.firstMatching(page, sels);
    if (btn) {
      await page.click(btn).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 400));
      return;
    }

    // Fallback: click any activity-bar control labeled Agent(s)
    await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll(
          "a,button,div[role='tab'],div[aria-label],.action-item",
        ),
      ) as HTMLElement[];
      for (const el of nodes) {
        const label = (
          el.getAttribute("aria-label") ||
          el.innerText ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (
          label === "agents" ||
          label === "agent" ||
          label.startsWith("agents ") ||
          label.startsWith("agent ")
        ) {
          el.click();
          return;
        }
      }
    });
    await new Promise((r) => setTimeout(r, 400));
  }

  private matchWindowForProject(
    windows: CursorWindow[],
    projectPath?: string,
    projectName?: string,
  ): CursorWindow | undefined {
    const basename = projectPath
      ? path.basename(projectPath.replace(/[\\/]+$/, ""))
      : undefined;
    const needles = [projectName, basename, projectPath]
      .filter((s): s is string => Boolean(s && s.trim()))
      .map((s) => s.toLowerCase());

    if (!needles.length) return undefined;

    const score = (w: CursorWindow): number => {
      const hay = `${w.title || ""} ${w.url || ""}`.toLowerCase();
      let best = 0;
      for (const n of needles) {
        if (!n) continue;
        if (hay.includes(n)) best = Math.max(best, n.length);
        const norm = n.replace(/\\/g, "/");
        if (hay.replace(/\\/g, "/").includes(norm)) {
          best = Math.max(best, norm.length);
        }
      }
      return best;
    };

    let best: CursorWindow | undefined;
    let bestScore = 0;
    for (const w of windows) {
      const s = score(w);
      if (s > bestScore) {
        bestScore = s;
        best = w;
      }
    }
    return bestScore > 0 ? best : undefined;
  }

  private async activateCurrentPage(): Promise<void> {
    const page = this.page;
    if (!page) return;
    try {
      await page.bringToFront();
    } catch {
      // ignore
    }
    try {
      await page.evaluate(() => {
        try {
          window.focus();
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore
    }
  }

  async sendMessage(text: string, submit = true): Promise<void> {
    await activateCursorApp();
    const page = await this.ensurePage();
    await this.activateCurrentPage();
    await this.withLock(this.targetId || "default", async () => {
      const inputSel = await this.firstMatching(page, this.selectors.chatInput);
      if (!inputSel) {
        throw new Error(
          "chat input not found — open Composer in the matching project window, or update selectors",
        );
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
      // Do not fire focus shortcuts here — they can create/rename chats or type into input.
      const clicked = await page.evaluate(
        (selectors, chatName) => {
          const norm = (s: string) =>
            s.replace(/\s+/g, " ").trim().toLowerCase();
          const want = norm(chatName);
          if (!want) return false;

          const firstLine = (el: HTMLElement) =>
            norm((el.innerText || el.textContent || "").split("\n")[0] || "");

          // Prefer exact first-line match within chat-list selectors only
          // (no broad document click — that renames / hits the wrong nodes).
          for (const sel of selectors) {
            const nodes = Array.from(document.querySelectorAll(sel));
            for (const node of nodes) {
              const el = node as HTMLElement;
              const t = firstLine(el);
              if (t === want) {
                el.click();
                return true;
              }
            }
          }
          for (const sel of selectors) {
            const nodes = Array.from(document.querySelectorAll(sel));
            for (const node of nodes) {
              const el = node as HTMLElement;
              const t = firstLine(el);
              if (t.startsWith(want) || want.startsWith(t)) {
                el.click();
                return true;
              }
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

  /** Open Composer / Agent panel so chat list + input exist. */
  private async focusComposerPanel(page: Page): Promise<void> {
    const hasInput = await this.firstMatching(page, this.selectors.chatInput);
    if (hasInput) return;
    const hasList = await this.firstMatching(page, this.selectors.chatListItem);
    if (hasList) return;
    // Avoid Cmd/Ctrl+L — it can open a new Agent chat. Leave panel as-is.
  }

  /** Start a fresh Composer chat in the current (or matched) window. */
  async newChat(opts: SelectComposerOpts = {}): Promise<{
    ok: boolean;
    window: CursorWindow;
    method: "button" | "shortcut" | "none";
  }> {
    await activateCursorApp();
    const { window } = await this.selectComposerContext({
      ...opts,
      chatName: undefined,
      skipActivate: true,
    });
    const page = await this.ensurePage(window.targetId);
    await this.focusComposerPanel(page);

    return this.withLock(this.targetId || "default", async () => {
      const sels = this.selectors.newChatButton || [];
      const btn = await this.firstMatching(page, sels);
      if (btn) {
        await page.click(btn);
        await new Promise((r) => setTimeout(r, 250));
        return { ok: true, window, method: "button" as const };
      }

      // Click any visible control whose label looks like New Chat
      const clickedLabel = await page.evaluate(() => {
        const nodes = Array.from(
          document.querySelectorAll("button,a,[role='button']"),
        );
        for (const node of nodes) {
          const el = node as HTMLElement;
          const t = (el.getAttribute("aria-label") || el.innerText || "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
          if (t === "new chat" || t.startsWith("new chat")) {
            el.click();
            return true;
          }
        }
        return false;
      });
      if (clickedLabel) {
        await new Promise((r) => setTimeout(r, 250));
        return { ok: true, window, method: "button" as const };
      }

      const mod = process.platform === "darwin" ? "Meta" : "Control";
      // Common Cursor/VS Code: Cmd/Ctrl+N or Cmd/Ctrl+Shift+L for new Agent chat
      await page.keyboard.down(mod);
      await page.keyboard.press("N");
      await page.keyboard.up(mod);
      await new Promise((r) => setTimeout(r, 300));

      // Verify we still have an input (new empty composer)
      const input = await this.firstMatching(page, this.selectors.chatInput);
      return {
        ok: Boolean(input),
        window,
        method: input ? ("shortcut" as const) : ("none" as const),
      };
    });
  }

  /** Stop the running agent generation if a Stop control is visible. */
  async stopGeneration(): Promise<boolean> {
    await activateCursorApp();
    const page = await this.ensurePage();
    await this.activateCurrentPage();
    return this.withLock(this.targetId || "default", async () => {
      const sels = this.selectors.stopButton || [];
      const btn = await this.firstMatching(page, sels);
      if (btn) {
        await page.click(btn);
        return true;
      }
      const clicked = await page.evaluate(() => {
        const nodes = Array.from(
          document.querySelectorAll("button,a,[role='button']"),
        );
        for (const node of nodes) {
          const el = node as HTMLElement;
          const t = (
            el.getAttribute("aria-label") ||
            el.getAttribute("title") ||
            el.innerText ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
          if (
            t === "stop" ||
            t.startsWith("stop ") ||
            t === "cancel" ||
            t.includes("stop generating")
          ) {
            el.click();
            return true;
          }
        }
        return false;
      });
      if (clicked) return true;
      // Escape often cancels generation in Composer
      await page.keyboard.press("Escape");
      return true;
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

  /**
   * Live agent status from Composer UI.
   * Past-tense transcript rows ("Explored…", "Thought for…") stay in the DOM after
   * the run ends — only in-progress labels + a visible Stop control count as running.
   */
  async scrapeAgentActivity(): Promise<{
    status?: string;
    labels: string[];
    currentModel?: string;
    running?: boolean;
  }> {
    const page = await this.ensurePage();
    return page.evaluate(() => {
      const labels: string[] = [];
      const push = (raw: string) => {
        const s = raw.replace(/\s+/g, " ").trim().split("·")[0].trim();
        // Keep full activity lines — the phone header shows them without ellipsis.
        if (!s || s.length > 240) return;
        if (labels.some((x) => x.toLowerCase() === s.toLowerCase())) return;
        labels.push(s);
      };

      // Present-tense / in-flight only. Do NOT match Explored, Grepped, Thought, Reading…
      const liveRe =
        /^(Thinking|Planning|Exploring|Making edits|Running|Searching|Editing|Generating)\b/i;

      const roots = Array.from(
        document.querySelectorAll(
          ".agent-transcript-row-activity, .ui-step-group-collapsible, [class*='agent-transcript-activity']",
        ),
      ) as HTMLElement[];

      for (const el of roots) {
        const first = (el.innerText || "").trim().split("\n")[0] || "";
        if (liveRe.test(first)) push(first);
      }

      for (const el of Array.from(
        document.querySelectorAll(
          "[class*='generating'], [aria-label*='Thinking'], [aria-label*='Planning'], [aria-label*='Generating']",
        ),
      )) {
        const html = el as HTMLElement;
        const rect = html.getBoundingClientRect();
        if (rect.width < 2 && rect.height < 2) continue;
        const style = window.getComputedStyle(html);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const t =
          html.getAttribute("aria-label") ||
          (html.innerText || "").trim().split("\n")[0];
        if (t && liveRe.test(t)) push(t);
      }

      // Stop button is the most reliable "still generating" signal in Composer.
      const stopVisible = (() => {
        const nodes = Array.from(
          document.querySelectorAll("button,a,[role='button']"),
        );
        for (const node of nodes) {
          const el = node as HTMLElement;
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) continue;
          const style = window.getComputedStyle(el);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.pointerEvents === "none"
          ) {
            continue;
          }
          const t = (
            el.getAttribute("aria-label") ||
            el.getAttribute("title") ||
            el.innerText ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
          if (
            t === "stop" ||
            t.startsWith("stop ") ||
            t.includes("stop generating")
          ) {
            return true;
          }
        }
        return false;
      })();

      const priority = [
        /^Thinking/i,
        /^Planning/i,
        /^Making edits/i,
        /^Exploring/i,
        /^Running/i,
        /^Generating/i,
        /^Searching/i,
        /^Editing/i,
      ];
      let status: string | undefined;
      for (const re of priority) {
        status = [...labels].reverse().find((l) => re.test(l));
        if (status) break;
      }
      if (!status && stopVisible) status = "Working…";

      // Prefer Stop visibility; live labels alone also count (Stop can lag a tick).
      const running = stopVisible || Boolean(status);

      const trigger = document.querySelector(
        ".ui-model-picker__trigger, button:has(.ui-model-picker__trigger-text)",
      ) as HTMLElement | null;
      const currentModel = (trigger?.innerText || "")
        .replace(/[\u200b-\u200d\ufeff]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .split("\n")[0];

      return {
        // Only surface a status string when we believe the agent is actually running.
        status: running ? status : undefined,
        labels: labels.slice(-10),
        currentModel: currentModel || undefined,
        running,
      };
    });
  }

  async listConfirmations(): Promise<Confirmation[]> {
    const page = await this.ensurePage();
    const items = await page.evaluate(() => {
      const normalize = (s: string) =>
        s
          .replace(/[↵⏎]/g, "")
          .replace(/\s+/g, " ")
          .trim();
      const actionWords =
        /^(run|allow|accept|continue|confirm|approve|yes|skip|reject|deny|cancel|don'?t ask again|always allow)(\s|$)/i;

      type Raw = {
        id: string;
        text: string;
        summary?: string;
        command?: string;
        actions: Array<{
          id: string;
          label: string;
          risk: "low" | "medium" | "high";
        }>;
        /** DOM identity for nested dedupe */
        _el: Element;
        _score: number;
      };
      const drafts: Raw[] = [];

      const riskFor = (label: string): "low" | "medium" | "high" => {
        const lower = label.toLowerCase();
        if (
          /delete|overwrite|force|rm\s|format|drop\s/i.test(lower) ||
          lower.includes("always allow")
        ) {
          return "high";
        }
        if (/^(run|allow|accept|approve|continue|confirm|yes)$/i.test(lower)) {
          return "medium";
        }
        return "low";
      };

      const cleanActionLabel = (raw: string): string => {
        const first = normalize(raw).split("\n")[0].trim();
        // "Run ↵" / "Run Enter" → "Run"
        return first.replace(/\s*(enter|return)$/i, "").trim();
      };

      const collectActions = (root: Element) => {
        const actions: Raw["actions"] = [];
        const buttons = Array.from(
          root.querySelectorAll("button, [role='button'], a.monaco-button"),
        );
        for (const btn of buttons) {
          const el = btn as HTMLElement;
          const label = cleanActionLabel(
            el.getAttribute("aria-label") ||
              el.innerText ||
              el.textContent ||
              "",
          );
          if (!label || label.length > 40) continue;
          if (
            !actionWords.test(label) &&
            !/^(run|skip|cancel|allow)/i.test(label)
          ) {
            continue;
          }
          if (
            actions.some((a) => a.label.toLowerCase() === label.toLowerCase())
          ) {
            continue;
          }
          actions.push({
            id: `${actions.length}:${label}`,
            label,
            risk: riskFor(label),
          });
        }
        return actions;
      };

      const stripActionLabels = (text: string, actions: Raw["actions"]) => {
        let t = text;
        for (const a of actions) {
          const esc = a.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          t = t.replace(new RegExp(`(?:\\b|$)${esc}\\b`, "gi"), " ");
        }
        return normalize(t);
      };

      const extractCommand = (
        root: Element,
        actions: Raw["actions"],
      ): string | undefined => {
        const codeNodes = Array.from(
          root.querySelectorAll(
            "code, pre, .monaco-tokenized-source, [class*='command'], [class*='terminal'], [class*='shell']",
          ),
        ) as HTMLElement[];
        for (const node of codeNodes) {
          const t = stripActionLabels(
            normalize(node.innerText || node.textContent || ""),
            actions,
          );
          if (t.length >= 2 && t.length < 2000) return t;
        }
        const full = stripActionLabels(
          normalize((root as HTMLElement).innerText || ""),
          actions,
        );
        for (const line of full.split("\n").map((l) => l.trim())) {
          if (
            /^(npm |npx |yarn |pnpm |git |node |python |pip |cargo |go |curl |wget |cd |ls |dir |mkdir |rm |cp |mv |\$|#|>|Delete |Write |Edit |Create )/i.test(
              line,
            ) ||
            /^[a-z0-9_./\\-]+\.(ps1|sh|bat|cmd|mjs|js|ts|tsx|py)\b/i.test(line)
          ) {
            return line.slice(0, 1000);
          }
        }
        return undefined;
      };

      const isButtonOnlyNoise = (text: string, actions: Raw["actions"]) => {
        const stripped = stripActionLabels(text, actions);
        if (!stripped) return true;
        // "Skip Run" alone, or only action-ish words
        if (/^(skip|run|allow|cancel|reject|deny|yes|no)(\s+(skip|run|allow|cancel|reject|deny|yes|no))*$/i.test(stripped)) {
          return true;
        }
        return stripped.length < 4;
      };

      const candidates: Element[] = [];
      const pushCandidate = (el: Element | null) => {
        if (!el || candidates.includes(el)) return;
        candidates.push(el);
      };

      for (const el of Array.from(
        document.querySelectorAll(
          [
            "[role='dialog']",
            ".monaco-dialog-box",
            "[class*='confirmation']",
            "[class*='Confirmation']",
            "[class*='approval']",
            "[class*='Approval']",
            "[class*='pending-decision']",
            "[class*='tool-call-card']",
            "[data-testid*='confirm']",
            "[data-testid*='approval']",
          ].join(","),
        ),
      )) {
        pushCandidate(el);
      }

      // From each Run/Skip button, climb to the smallest ancestor that has
      // meaningful text beyond the buttons themselves (not every parent).
      const decisionButtons = Array.from(
        document.querySelectorAll("button, [role='button']"),
      ).filter((b) => {
        const label = cleanActionLabel(
          (b as HTMLElement).getAttribute("aria-label") ||
            (b as HTMLElement).innerText ||
            "",
        );
        return /^(run|allow|accept|approve|skip)$/i.test(label);
      });

      for (const btn of decisionButtons) {
        let root: Element | null = btn.parentElement;
        let best: Element | null = null;
        for (let i = 0; i < 8 && root; i++) {
          const actions = collectActions(root);
          if (actions.length < 1) {
            root = root.parentElement;
            continue;
          }
          const raw = normalize((root as HTMLElement).innerText || "");
          if (!isButtonOnlyNoise(raw, actions)) {
            best = root;
            break;
          }
          root = root.parentElement;
        }
        pushCandidate(best);
      }

      for (const dialog of candidates) {
        const el = dialog as HTMLElement;
        const actions = collectActions(el);
        if (actions.length === 0) continue;
        const hasDecision = actions.some((a) =>
          /run|allow|accept|approve|skip|cancel|reject|deny/i.test(a.label),
        );
        if (!hasDecision) continue;

        const rawText = normalize(el.innerText || "");
        if (!rawText || isButtonOnlyNoise(rawText, actions)) continue;

        const command = extractCommand(el, actions);
        const cleaned = stripActionLabels(rawText, actions);
        if (!cleaned || isButtonOnlyNoise(cleaned, actions)) continue;

        const lines = cleaned
          .split(/[\n•]/)
          .map((l) => l.trim())
          .filter(Boolean);
        const title =
          lines.find((l) =>
            /^(delete|run|write|edit|create|allow|approve|command|terminal|shell|network|overwrite)/i.test(
              l,
            ),
          ) ||
          lines.find((l) => l.length > 8) ||
          lines[0] ||
          "Approval needed";

        const summaryLines = lines.filter((l) => {
          if (l === title) return false;
          if (command && l === command) return false;
          if (l.length < 3) return false;
          return true;
        });
        const summary = summaryLines.slice(0, 6).join("\n").slice(0, 600);

        // Prefer cards with a real title/command and more unique content.
        const score =
          (command ? 40 : 0) +
          Math.min(cleaned.length, 200) +
          ( /delete|write|edit|run command|terminal/i.test(title) ? 20 : 0);

        drafts.push({
          id: `dlg-${drafts.length}`,
          text: title.slice(0, 160),
          summary: summary && summary !== title ? summary : undefined,
          command,
          actions,
          _el: el,
          _score: score,
        });
      }

      // Drop nested duplicates: if A contains B (or vice versa) keep higher score.
      const kept: Raw[] = [];
      const sorted = [...drafts].sort((a, b) => b._score - a._score);
      for (const item of sorted) {
        const nested = kept.some(
          (k) =>
            k._el.contains(item._el) ||
            item._el.contains(k._el) ||
            (k.command &&
              item.command &&
              k.command === item.command &&
              k.actions.map((a) => a.label).join() ===
                item.actions.map((a) => a.label).join()),
        );
        if (nested) continue;
        // Same action set + title is a substring of an already-kept item
        const redundant = kept.some((k) => {
          const sameActions =
            k.actions.map((a) => a.label.toLowerCase()).join("|") ===
            item.actions.map((a) => a.label.toLowerCase()).join("|");
          if (!sameActions) return false;
          const kt = (k.command || k.text).toLowerCase();
          const it = (item.command || item.text).toLowerCase();
          return kt.includes(it) || it.includes(kt);
        });
        if (redundant) continue;
        kept.push(item);
      }

      const stableId = (item: Raw) => {
        const raw = [
          item.text,
          item.command || "",
          item.actions.map((a) => a.label).join("|"),
        ].join("::");
        let h = 0;
        for (let i = 0; i < raw.length; i++) {
          h = (h * 31 + raw.charCodeAt(i)) | 0;
        }
        return `dlg-${(h >>> 0).toString(16)}`;
      };

      return kept.map(({ _el: _unused, _score: _s, ...rest }) => ({
        ...rest,
        id: stableId(rest as Raw),
      }));
    });
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
    await activateCursorApp();
    const page = await this.ensurePage();
    await this.activateCurrentPage();
    return page.evaluate((label) => {
      const want = label
        .replace(/[↵⏎]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
        .replace(/\s*(enter|return)$/i, "");
      const buttons = Array.from(
        document.querySelectorAll("button, [role='button'], a.monaco-button"),
      );
      for (const btn of buttons) {
        const el = btn as HTMLElement;
        const t = (
          el.getAttribute("aria-label") ||
          el.innerText ||
          el.textContent ||
          ""
        )
          .replace(/[↵⏎]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .split("\n")[0]
          .toLowerCase()
          .replace(/\s*(enter|return)$/i, "");
        if (t === want || t.startsWith(want + " ")) {
          el.click();
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
