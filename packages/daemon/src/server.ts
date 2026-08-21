import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import cors from "cors";
import QRCode from "qrcode";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DEFAULT_CDP_PORT,
  DEFAULT_DAEMON_PORT,
  type ComposerClientMessage,
  type ComposerServerMessage,
  type PairingInfo,
} from "@cursor-remote/shared";
import { loadOrCreateAuth, requireAuth, rotateAuth, tokenFromUrl } from "./auth.js";
import { CdpDriver, loadSelectorPack } from "./cdp-driver.js";
import { CursorStore } from "./cursor-store.js";
import { getProjectDiff } from "./git-diff.js";
import { ensureDir, resolveCursorPaths } from "./paths.js";
import { pickAdvertiseHost, detectAdvertiseHosts } from "./advertise-host.js";
import { formatAttachmentsForPrompt, saveBase64Upload } from "./uploads.js";
import { TerminalHub, ensurePtyPermissions } from "./terminal.js";
import { activateCursorApp } from "./open-cursor.js";
import { contentTypeForImage, isAllowedMediaPath } from "./media.js";
import { ComposerMonitor } from "./composer-monitor.js";

export type DaemonOptions = {
  port?: number;
  bindHost?: string;
  cdpUrl?: string;
  dataDir?: string;
  cursorUserDir?: string;
};

function sendComposer(ws: WebSocket, msg: ComposerServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<{
  port: number;
  token: string;
  close: () => Promise<void>;
}> {
  const port = opts.port ?? Number(process.env.PORT || DEFAULT_DAEMON_PORT);
  const bindHost = opts.bindHost ?? process.env.BIND_HOST ?? "0.0.0.0";
  const cdpUrl =
    opts.cdpUrl ??
    process.env.CDP_URL ??
    `http://127.0.0.1:${process.env.CDP_PORT || DEFAULT_CDP_PORT}`;
  const dataDir =
    opts.dataDir ??
    process.env.DATA_DIR ??
    path.join(os.homedir(), ".cursor-remote");
  ensureDir(dataDir);

  let auth = loadOrCreateAuth(dataDir);
  const paths = resolveCursorPaths(opts.cursorUserDir);
  const store = new CursorStore(paths);
  const selectors = loadSelectorPack("default");
  const cdp = new CdpDriver(cdpUrl, selectors);
  const composerMonitor = new ComposerMonitor(cdp, store);
  ensurePtyPermissions();
  const terminals = new TerminalHub();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "32mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "cursor-remote-daemon" });
  });

  app.get("/", async (_req, res) => {
    const info = buildPairing(bindHost, port, auth.token);
    const advertiseHost = pickAdvertiseHost(bindHost);
    let qrDataUrl = "";
    try {
      qrDataUrl = await QRCode.toDataURL(info.qrPayload, { width: 320, margin: 2 });
    } catch {
      qrDataUrl = "";
    }
    res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Cursor Remote</title>
<style>
body{font-family:ui-sans-serif,system-ui;max-width:560px;margin:40px auto;padding:0 16px;background:#f7f4ee;color:#1c1915}
code,pre{background:#fffdf8;padding:2px 6px;border-radius:6px;word-break:break-all}
img{width:280px;height:280px;background:#fff;border-radius:12px;display:block;margin:12px 0}
.note{background:#ebe4d6;padding:12px;border-radius:12px;line-height:1.4}
</style></head><body>
<h1>Cursor Remote</h1>
<p class="note"><strong>Scan this QR inside the mobile app</strong> (Pair → Scan QR) — not with Expo Go’s home scanner.</p>
<p><strong>Host</strong> ${advertiseHost}<br/>
<strong>Port</strong> ${port}<br/>
<strong>Token</strong> <code>${auth.token}</code></p>
<p>Payload:</p>
<pre>${info.qrPayload}</pre>
${qrDataUrl ? `<p><img alt="pairing qr" src="${qrDataUrl}"/></p>` : ""}
<p>${info.hint}</p>
</body></html>`);
  });

  app.get("/pairing", async (_req, res) => {
    const info = buildPairing(bindHost, port, auth.token);
    let qrDataUrl: string | undefined;
    try {
      qrDataUrl = await QRCode.toDataURL(info.qrPayload);
    } catch {
      qrDataUrl = undefined;
    }
    res.json({ ...info, qrDataUrl });
  });

  app.use(requireAuth(() => auth.token));

  app.post("/auth/rotate", (_req, res) => {
    auth = rotateAuth(dataDir);
    res.json(buildPairing(bindHost, port, auth.token));
  });

  app.get("/projects", (_req, res) => {
    res.json({ projects: store.listProjects() });
  });

  app.get("/projects/:id", (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(project);
  });

  app.get("/projects/:id/chats", (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ chats: store.listChats(req.params.id) });
  });

  app.get("/chats/:id", (req, res) => {
    let revision = store.getChatRevision(req.params.id);
    if (!revision) {
      res.status(404).json({ error: "not found" });
      return;
    }
    let chat = null;
    for (let attempt = 0; attempt < 3 && revision; attempt += 1) {
      const candidate = store.getChat(req.params.id, revision);
      const after = store.getChatRevision(req.params.id);
      if (candidate && after === revision) {
        chat = candidate;
        break;
      }
      revision = after;
    }
    if (!chat || !revision) {
      res.status(503).json({ error: "chat is changing; retry" });
      return;
    }
    res.json({ ...chat, revision });
  });

  app.get("/chats/:id/changed-file", (req, res) => {
    const filePath = String(req.query.path || "");
    if (!filePath) {
      res.status(400).json({ error: "path required" });
      return;
    }
    const file = store.getChangedFileDiff(req.params.id, filePath);
    if (!file) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(file);
  });

  /** Serve chat attachment / screenshot images from the host disk. */
  app.get("/media", (req, res) => {
    const filePath = String(req.query.path || "");
    if (!filePath) {
      res.status(400).json({ error: "path required" });
      return;
    }
    const check = isAllowedMediaPath(filePath, paths, dataDir);
    if (!check.ok) {
      res.status(check.error === "not found" ? 404 : 403).json({
        error: check.error,
      });
      return;
    }
    res.setHeader("Content-Type", contentTypeForImage(check.resolved));
    res.setHeader("Cache-Control", "private, max-age=3600");
    fs.createReadStream(check.resolved).pipe(res);
  });

  app.get("/projects/:id/diff", async (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (!fs.existsSync(project.path)) {
      res.status(404).json({ error: "project path missing on disk" });
      return;
    }
    try {
      const diff = await getProjectDiff(project.id, project.path);
      res.json(diff);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/composer/health", async (_req, res) => {
    try {
      res.json(await cdp.health());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/composer/activity", async (_req, res) => {
    try {
      const activity = await cdp.scrapeAgentActivity();
      res.json(activity);
    } catch (err) {
      res.status(503).json({
        error: (err as Error).message,
        status: undefined,
        labels: [],
      });
    }
  });

  app.get("/windows", async (_req, res) => {
    try {
      res.json({ windows: await cdp.listWindows() });
    } catch (err) {
      res.status(503).json({
        error: (err as Error).message,
        hint: "Launch Cursor with --remote-debugging-port (see scripts/)",
      });
    }
  });

  app.post("/composer/select", async (req, res) => {
    try {
      await activateCursorApp();
      const projectId =
        typeof req.body?.projectId === "string" ? req.body.projectId : undefined;
      const project = projectId ? store.getProject(projectId) : undefined;
      const result = await cdp.selectComposerContext({
        targetId: req.body?.targetId,
        chatId: req.body?.chatId ? String(req.body.chatId) : undefined,
        chatName: req.body?.chatName
          ? String(req.body.chatName)
          : undefined,
        projectPath:
          (typeof req.body?.projectPath === "string" && req.body.projectPath) ||
          project?.path,
        projectName:
          (typeof req.body?.projectName === "string" && req.body.projectName) ||
          project?.name,
        skipActivate: true,
        // Bind via Agents → Repositories (never Open Recent / never type).
        switchIfNeeded: true,
        requireProjectMatch: false,
      });
      if (result.chatSelected !== false && req.body?.chatId) {
        composerMonitor.setActiveChat(String(req.body.chatId));
      }
      res.json({
        window: result.window,
        chatSelected: result.chatSelected,
        matchedBy: result.matchedBy,
        repoSelected: result.repoSelected,
      });
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });

  app.post("/composer/new-chat", async (req, res) => {
    try {
      const projectId =
        typeof req.body?.projectId === "string" ? req.body.projectId : undefined;
      const project = projectId ? store.getProject(projectId) : undefined;
      if (projectId && !project) {
        res.status(404).json({ error: "project not found" });
        return;
      }
      // Switch via Agents → Repositories left panel (never spawn / Open Recent).
      if (project) {
        await cdp.selectComposerContext({
          projectPath: project.path,
          projectName: project.name,
          switchIfNeeded: true,
          requireProjectMatch: true,
        });
      }
      const result = await cdp.newChat({
        projectPath: project?.path,
        projectName: project?.name,
        targetId: req.body?.targetId,
        switchIfNeeded: false,
      });
      res.json(result);
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });

  app.post("/composer/stop", async (_req, res) => {
    try {
      const ok = await cdp.stopGeneration();
      composerMonitor.wake();
      res.json({ ok });
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });

  app.post("/projects/:id/open", async (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }
    try {
      await activateCursorApp();
      // Click the repo in Agents → Repositories (same window, no Open Recent).
      const result = await cdp.selectComposerContext({
        projectPath: project.path,
        projectName: project.name,
        skipActivate: true,
        switchIfNeeded: true,
        requireProjectMatch: true,
      });
      res.json({
        ok: true,
        message:
          result.matchedBy === "agentsPanel"
            ? `Selected ${project.name} in Agents → Repositories`
            : `Focused Cursor for ${project.name}`,
        window: result.window,
        matchedBy: result.matchedBy,
        repoSelected: result.repoSelected,
      });
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });

  app.post("/composer/send", async (req, res) => {
    const text = String(req.body?.text || "");
    const attachmentPaths = Array.isArray(req.body?.attachmentPaths)
      ? (req.body.attachmentPaths as string[])
      : [];
    const attachments = attachmentPaths
      .filter((p) => typeof p === "string" && p.length > 0)
      .map((p) => ({
        id: "",
        name: path.basename(p),
        mime: "application/octet-stream",
        path: p,
        size: 0,
      }));
    const full =
      text.trim() + formatAttachmentsForPrompt(attachments);
    if (!full.trim()) {
      res.status(400).json({ error: "text or attachments required" });
      return;
    }
    try {
      const projectId =
        typeof req.body?.projectId === "string" ? req.body.projectId : undefined;
      const project = projectId ? store.getProject(projectId) : undefined;
      const chatName =
        typeof req.body?.chatName === "string" ? req.body.chatName : undefined;
      const chatId =
        typeof req.body?.chatId === "string" ? req.body.chatId : undefined;
      if (project || chatName || chatId || req.body?.targetId) {
        const bind = await cdp.selectComposerContext({
          targetId: req.body?.targetId,
          chatId,
          chatName,
          projectPath: project?.path,
          projectName: project?.name,
          switchIfNeeded: true,
          requireProjectMatch: Boolean(project),
        });
        if (
          project &&
          bind.matchedBy === "fallback" &&
          !bind.repoSelected &&
          !bind.chatSelected
        ) {
          res.status(409).json({
            error: `Refusing to send — could not select ${project.name} in Agents → Repositories. Open the Agents sidebar in Cursor, then retry.`,
          });
          return;
        }
      }
      await cdp.sendMessage(full, req.body?.submit !== false, {
        force: Boolean(req.body?.force),
      });
      if (chatId) composerMonitor.setActiveChat(chatId);
      composerMonitor.wake();
      res.json({ ok: true });
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });

  app.get("/composer/models", async (_req, res) => {
    try {
      const menu = await cdp.listModelMenu();
      if (!menu.models.length) {
        res.status(503).json({
          error:
            "CDP model menu scrape returned no models — open Composer and retune model picker selectors",
          source: "cdp",
          models: [],
          params: null,
        });
        return;
      }
      res.json({
        source: "cdp",
        current: menu.current,
        models: menu.models.map((label) => ({
          id: label
            .toLowerCase()
            .replace(/[\u200b-\u200d\ufeff]/g, "")
            .replace(/\s+/g, "-"),
          label,
        })),
        params: menu.params
          ? {
              modelLabel: menu.current || menu.params.baseModel || "",
              baseModel: menu.params.baseModel,
              sections: menu.params.sections,
            }
          : null,
      });
    } catch (err) {
      res.status(503).json({
        error: (err as Error).message,
        source: "cdp",
        models: [],
        params: null,
      });
    }
  });

  app.get("/composer/model-params", async (req, res) => {
    const modelLabel =
      typeof req.query.model === "string" ? req.query.model : undefined;
    try {
      const params = await cdp.getModelParams(modelLabel);
      res.json({ source: "cdp", ...params });
    } catch (err) {
      res.status(503).json({ error: (err as Error).message, sections: [] });
    }
  });

  app.post("/composer/model", async (req, res) => {
    const modelLabel = String(req.body?.modelLabel || "");
    if (!modelLabel) {
      res.status(400).json({ error: "modelLabel required" });
      return;
    }
    const choices =
      req.body?.choices && typeof req.body.choices === "object"
        ? (req.body.choices as Record<string, string>)
        : undefined;
    const toggles =
      req.body?.toggles && typeof req.body.toggles === "object"
        ? (req.body.toggles as Record<string, boolean>)
        : undefined;
    // Back-compat with older mobile clients
    const effort =
      typeof req.body?.effort === "string" ? String(req.body.effort) : undefined;
    const fastMode =
      typeof req.body?.fastMode === "boolean" ? req.body.fastMode : undefined;
    const mergedChoices = { ...(choices || {}) };
    if (effort && !mergedChoices.Effort) {
      mergedChoices.Effort = /^(extra\s*high|xhigh)$/i.test(effort)
        ? "Extra High"
        : effort;
    }
    const mergedToggles = { ...(toggles || {}) };
    if (fastMode !== undefined && mergedToggles.Fast === undefined) {
      mergedToggles.Fast = fastMode;
    }
    try {
      const ok = await cdp.applyModelConfig({
        modelLabel,
        choices: Object.keys(mergedChoices).length ? mergedChoices : undefined,
        toggles: Object.keys(mergedToggles).length ? mergedToggles : undefined,
      });
      composerMonitor.wake();
      res.json({ ok });
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });

  app.post("/composer/upload", async (req, res) => {
    const name = String(req.body?.name || "file");
    const mime = String(req.body?.mime || "application/octet-stream");
    const base64 = String(req.body?.base64 || "");
    if (!base64) {
      res.status(400).json({ error: "base64 required" });
      return;
    }
    try {
      const meta = saveBase64Upload(dataDir, name, mime, base64);
      res.json({ attachment: meta });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/composer/confirmations", async (_req, res) => {
    try {
      res.json({ items: await cdp.listConfirmations() });
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });

  app.post("/composer/confirmations", async (req, res) => {
    try {
      const ok = await cdp.actOnConfirmation(
        String(req.body?.confirmationId || ""),
        String(req.body?.actionId || ""),
      );
      composerMonitor.wake();
      res.json({ ok });
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });

  app.post("/selectors/reload", (req, res) => {
    const name = String(req.body?.name || "default");
    try {
      cdp.reloadSelectors(name);
      res.json({ ok: true, pack: name });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const token = tokenFromUrl(url.toString()) || undefined;
    const header = req.headers["sec-websocket-protocol"];
    const protoToken =
      typeof header === "string" ? header.split(",").map((s) => s.trim())[0] : undefined;
    if (token !== auth.token && protoToken !== auth.token) {
      // auth.token is current; rotate invalidates old WS tokens intentionally
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.pathname === "/terminal") {
        terminals.handle(ws, (projectId) => store.getProject(projectId)?.path);
        return;
      }
      if (url.pathname === "/composer") {
        handleComposerWs(ws, cdp, composerMonitor);
        return;
      }
      ws.close(1008, "unknown path");
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(port, bindHost, () => resolve());
  });

  const pairing = buildPairing(bindHost, port, auth.token);
  console.log(`[cursor-remote] listening on http://${bindHost}:${port}`);
  console.log(`[cursor-remote] CDP target ${cdpUrl}`);
  console.log(`[cursor-remote] pairing payload: ${pairing.qrPayload}`);
  console.log(`[cursor-remote] token stored in ${path.join(dataDir, "auth.json")}`);

  return {
    port,
    token: auth.token,
    close: async () => {
      await composerMonitor.close();
      terminals.close();
      await cdp.disconnect();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function buildPairing(bindHost: string, port: number, token: string): PairingInfo {
  const host = pickAdvertiseHost(bindHost);
  const allHosts = detectAdvertiseHosts();
  const qrPayload = `cursor-remote://pair?host=${encodeURIComponent(host)}&port=${port}&token=${encodeURIComponent(token)}`;
  return {
    token,
    port,
    bindHost,
    qrPayload,
    hint:
      allHosts.length > 1
        ? `QR uses ${host}. Other interfaces: ${allHosts.join(", ")}. Set PAIR_HOST=... to force one. Keep CDP (9222) localhost-only.`
        : `Scan this QR inside the Cursor Remote app (Pair → Scan QR). Keep CDP (9222) localhost-only.`,
  };
}

function handleComposerWs(
  ws: WebSocket,
  cdp: CdpDriver,
  monitor: ComposerMonitor,
): void {
  monitor.attach(ws);
  ws.on("message", async (raw) => {
    let msg: ComposerClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ComposerClientMessage;
    } catch {
      sendComposer(ws, { type: "error", message: "invalid json" });
      return;
    }

    try {
      if (msg.type === "ping") {
        sendComposer(ws, { type: "pong" });
        return;
      }
      if (msg.type === "subscribe") {
        sendComposer(ws, {
          type: "capabilities",
          chatDeltas: true,
          typedApprovals: true,
          turnComplete: true,
        });
        await monitor.subscribe(ws, msg.targetId);
        return;
      }
      if (msg.type === "subscribeChat") {
        await monitor.subscribeChat(ws, msg.chatId, msg.revision);
        return;
      }
      if (msg.type === "unsubscribeChat") {
        monitor.unsubscribeChat(ws, msg.chatId);
        return;
      }
      if (msg.type === "send") {
        await cdp.sendMessage(msg.text, msg.submit !== false, {
          force: Boolean(msg.force),
        });
        monitor.wake();
        sendComposer(ws, {
          type: "event",
          kind: "sent",
          text: msg.text,
          at: Date.now(),
        });
        return;
      }
      if (msg.type === "selectChat") {
        const name = msg.chatName || msg.chatId || "";
        const ok = await cdp.selectChatByName(name);
        if (ok && msg.chatId) monitor.setActiveChat(msg.chatId);
        monitor.wake();
        sendComposer(ws, {
          type: "event",
          kind: ok ? "chat_selected" : "chat_select_failed",
          text: name,
          at: Date.now(),
        });
        return;
      }
      if (msg.type === "selectModel") {
        const ok = await cdp.selectModel(msg.modelLabel);
        monitor.wake();
        sendComposer(ws, {
          type: "event",
          kind: ok ? "model_selected" : "model_select_failed",
          text: msg.modelLabel,
          at: Date.now(),
        });
        return;
      }
      if (msg.type === "confirm") {
        const ok = await cdp.actOnConfirmation(
          msg.confirmationId,
          msg.actionId,
        );
        monitor.wake();
        sendComposer(ws, {
          type: "event",
          kind: ok ? "confirmation_acted" : "confirmation_failed",
          at: Date.now(),
        });
      }
    } catch (err) {
      sendComposer(ws, { type: "error", message: (err as Error).message });
    }
  });

  ws.on("close", () => monitor.detach(ws));
}
