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
    const chat = store.getChat(req.params.id);
    if (!chat) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(chat);
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
      const window = await cdp.selectWindow(req.body?.targetId);
      if (req.body?.chatName) {
        await cdp.selectChatByName(String(req.body.chatName));
      }
      res.json({ window });
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
      await cdp.sendMessage(full, req.body?.submit !== false);
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
        handleComposerWs(ws, cdp);
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

function handleComposerWs(ws: WebSocket, cdp: CdpDriver): void {
  let timer: NodeJS.Timeout | null = null;

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

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
        if (msg.targetId) await cdp.selectWindow(msg.targetId);
        sendComposer(ws, { type: "status", health: await cdp.health() });
        stop();
        timer = setInterval(async () => {
          try {
            const event = await cdp.pollDomEvents();
            if (event) {
              sendComposer(ws, {
                type: "event",
                kind: event.kind,
                text: event.text,
                at: Date.now(),
              });
            }
            const items = await cdp.listConfirmations();
            if (items.length) {
              sendComposer(ws, { type: "confirmations", items });
            }
          } catch (err) {
            sendComposer(ws, {
              type: "error",
              message: (err as Error).message,
            });
          }
        }, 1500);
        return;
      }
      if (msg.type === "send") {
        await cdp.sendMessage(msg.text, msg.submit !== false);
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

  ws.on("close", stop);
}
