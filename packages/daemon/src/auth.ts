import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";
import { ensureDir } from "./paths.js";

export type AuthStore = {
  token: string;
  createdAt: number;
};

export function loadOrCreateAuth(dataDir: string): AuthStore {
  ensureDir(dataDir);
  const file = path.join(dataDir, "auth.json");
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, "utf8")) as AuthStore;
  }
  const store: AuthStore = {
    token: crypto.randomBytes(24).toString("base64url"),
    createdAt: Date.now(),
  };
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
  return store;
}

export function rotateAuth(dataDir: string): AuthStore {
  const file = path.join(dataDir, "auth.json");
  const store: AuthStore = {
    token: crypto.randomBytes(24).toString("base64url"),
    createdAt: Date.now(),
  };
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
  return store;
}

export function extractToken(req: Request): string | undefined {
  const header = req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  const q = req.query.token;
  if (typeof q === "string" && q.length > 0) return q;
  const h = req.header("x-cursor-remote-token");
  return h || undefined;
}

export function requireAuth(getToken: () => string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === "/healthz" || req.path === "/pairing" || req.path === "/") {
      next();
      return;
    }
    const provided = extractToken(req);
    if (!provided || provided !== getToken()) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

export function tokenFromUrl(url: string): string | undefined {
  try {
    const u = new URL(url, "http://localhost");
    return u.searchParams.get("token") || undefined;
  } catch {
    return undefined;
  }
}
