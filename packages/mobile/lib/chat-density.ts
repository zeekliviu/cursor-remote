import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  CHAT_DENSITIES,
  type ChatDensity,
} from "./chat-turns";

export { CHAT_DENSITIES };
export type { ChatDensity };

export const DEFAULT_CHAT_DENSITY: ChatDensity = "balanced";
export const MAX_CHAT_EXPANSION_ENTRIES = 100;

export const CHAT_DENSITY_OPTIONS: ReadonlyArray<{
  value: ChatDensity;
  label: "Compact" | "Balanced" | "Detailed";
}> = [
  { value: "compact", label: "Compact" },
  { value: "balanced", label: "Balanced" },
  { value: "detailed", label: "Detailed" },
];

const DENSITY_KEY_PREFIX = "cursor-remote:chat-density.v1";
const EXPANSION_KEY_PREFIX = "cursor-remote:chat-expansion.v1";
const EMPTY_EXPANSION: Readonly<Record<string, boolean>> = Object.freeze({});

export function isChatDensity(value: unknown): value is ChatDensity {
  return (
    typeof value === "string" &&
    (CHAT_DENSITIES as readonly string[]).includes(value)
  );
}

function storagePart(value: string): string {
  return encodeURIComponent(value);
}

export function chatDensityStorageKey(hostId: string): string {
  return `${DENSITY_KEY_PREFIX}:${storagePart(hostId)}`;
}

export function chatExpansionStorageKey(
  hostId: string,
  chatId: string,
): string {
  return `${EXPANSION_KEY_PREFIX}:${storagePart(hostId)}:${storagePart(chatId)}`;
}

export type UseChatDensityResult = {
  density: ChatDensity;
  setDensity: (density: ChatDensity) => void;
  hydrated: boolean;
};

/** A Balanced-by-default density preference isolated to one daemon host. */
export function useChatDensity(
  hostId?: string | null,
): UseChatDensityResult {
  const [density, setDensityState] =
    useState<ChatDensity>(DEFAULT_CHAT_DENSITY);
  const [hydrated, setHydrated] = useState(false);
  const revision = useRef(0);

  useEffect(() => {
    const loadRevision = ++revision.current;
    let cancelled = false;
    setDensityState(DEFAULT_CHAT_DENSITY);
    setHydrated(false);

    if (!hostId) {
      setHydrated(true);
      return () => {
        cancelled = true;
      };
    }

    void AsyncStorage.getItem(chatDensityStorageKey(hostId))
      .then((stored) => {
        if (cancelled || revision.current !== loadRevision) return;
        setDensityState(
          isChatDensity(stored) ? stored : DEFAULT_CHAT_DENSITY,
        );
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled && revision.current === loadRevision) setHydrated(true);
      });

    return () => {
      cancelled = true;
    };
  }, [hostId]);

  const setDensity = useCallback(
    (nextDensity: ChatDensity) => {
      revision.current += 1;
      setDensityState(nextDensity);
      setHydrated(true);
      if (!hostId) return;
      void AsyncStorage.setItem(
        chatDensityStorageKey(hostId),
        nextDensity,
      ).catch(() => undefined);
    },
    [hostId],
  );

  return useMemo(
    () => ({ density, setDensity, hydrated }),
    [density, hydrated, setDensity],
  );
}

type ExpansionSnapshot = {
  scope: string | undefined;
  values: Readonly<Record<string, boolean>>;
  /** Oldest first, so capping removes entries least recently changed. */
  order: string[];
  hydrated: boolean;
};

type StoredExpansionState = {
  version: 1;
  entries: Array<[id: string, expanded: boolean]>;
};

function normalizedCap(maxEntries: number): number {
  return Number.isFinite(maxEntries) && maxEntries > 0
    ? Math.max(1, Math.floor(maxEntries))
    : MAX_CHAT_EXPANSION_ENTRIES;
}

function capExpansion(
  values: Readonly<Record<string, boolean>>,
  order: readonly string[],
  maxEntries: number,
): Pick<ExpansionSnapshot, "values" | "order"> {
  const cap = normalizedCap(maxEntries);
  const nextOrder = [...new Set(order)]
    .filter((id) => Object.hasOwn(values, id))
    .slice(-cap);
  const nextValues: Record<string, boolean> = {};
  for (const id of nextOrder) nextValues[id] = values[id] ?? false;
  return { values: nextValues, order: nextOrder };
}

function parseExpansion(
  raw: string | null,
  maxEntries: number,
): Pick<ExpansionSnapshot, "values" | "order"> {
  if (!raw) return { values: {}, order: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { values: {}, order: [] };
    }

    const candidate = parsed as Partial<StoredExpansionState>;
    if (!Array.isArray(candidate.entries)) {
      return { values: {}, order: [] };
    }

    const values: Record<string, boolean> = {};
    const order: string[] = [];
    for (const entry of candidate.entries) {
      if (
        !Array.isArray(entry) ||
        typeof entry[0] !== "string" ||
        !entry[0] ||
        typeof entry[1] !== "boolean"
      ) {
        continue;
      }
      values[entry[0]] = entry[1];
      order.push(entry[0]);
    }
    return capExpansion(values, order, maxEntries);
  } catch {
    return { values: {}, order: [] };
  }
}

function serializeExpansion(snapshot: ExpansionSnapshot): string {
  const stored: StoredExpansionState = {
    version: 1,
    entries: snapshot.order.map((id) => [
      id,
      snapshot.values[id] ?? false,
    ]),
  };
  return JSON.stringify(stored);
}

export type UseChatExpansionStateResult = {
  expanded: Readonly<Record<string, boolean>>;
  isExpanded: (id: string, defaultExpanded?: boolean) => boolean;
  setExpanded: (id: string, expanded: boolean) => void;
  toggleExpanded: (id: string, defaultExpanded?: boolean) => void;
  clearExpanded: () => void;
  hydrated: boolean;
};

/**
 * Persist disclosure overrides for one host/chat and retain only the most
 * recently changed entries. Defaults remain the turn model's responsibility.
 */
export function useChatExpansionState(
  hostId?: string | null,
  chatId?: string | null,
  maxEntries = MAX_CHAT_EXPANSION_ENTRIES,
): UseChatExpansionStateResult {
  const scope =
    hostId && chatId ? chatExpansionStorageKey(hostId, chatId) : undefined;
  const cap = normalizedCap(maxEntries);
  const revision = useRef(0);
  const [snapshot, setSnapshot] = useState<ExpansionSnapshot>(() => ({
    scope,
    values: EMPTY_EXPANSION,
    order: [],
    hydrated: !scope,
  }));

  useEffect(() => {
    const loadRevision = ++revision.current;
    let cancelled = false;
    setSnapshot({
      scope,
      values: EMPTY_EXPANSION,
      order: [],
      hydrated: !scope,
    });
    if (!scope) {
      return () => {
        cancelled = true;
      };
    }

    void AsyncStorage.getItem(scope)
      .then((raw) => {
        if (cancelled || revision.current !== loadRevision) return;
        const parsed = parseExpansion(raw, cap);
        setSnapshot({
          scope,
          ...parsed,
          hydrated: true,
        });
      })
      .catch(() => {
        if (cancelled || revision.current !== loadRevision) return;
        setSnapshot({
          scope,
          values: EMPTY_EXPANSION,
          order: [],
          hydrated: true,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [cap, scope]);

  useEffect(() => {
    if (!scope || snapshot.scope !== scope || !snapshot.hydrated) return;
    void AsyncStorage.setItem(scope, serializeExpansion(snapshot)).catch(
      () => undefined,
    );
  }, [scope, snapshot]);

  const changeExpanded = useCallback(
    (
      id: string,
      resolve: (current: boolean | undefined) => boolean,
    ): void => {
      if (!id) return;
      revision.current += 1;
      setSnapshot((current) => {
        const values =
          current.scope === scope
            ? { ...current.values }
            : ({} as Record<string, boolean>);
        const order = current.scope === scope ? current.order : [];
        values[id] = resolve(values[id]);
        const capped = capExpansion(
          values,
          [...order.filter((entryId) => entryId !== id), id],
          cap,
        );
        return {
          scope,
          ...capped,
          hydrated: true,
        };
      });
    },
    [cap, scope],
  );

  const values =
    snapshot.scope === scope ? snapshot.values : EMPTY_EXPANSION;
  const hydrated =
    snapshot.scope === scope ? snapshot.hydrated : false;

  const isExpanded = useCallback(
    (id: string, defaultExpanded = false): boolean =>
      values[id] ?? defaultExpanded,
    [values],
  );

  const setExpanded = useCallback(
    (id: string, expanded: boolean) => {
      changeExpanded(id, () => expanded);
    },
    [changeExpanded],
  );

  const toggleExpanded = useCallback(
    (id: string, defaultExpanded = false) => {
      changeExpanded(id, (current) => !(current ?? defaultExpanded));
    },
    [changeExpanded],
  );

  const clearExpanded = useCallback(() => {
    revision.current += 1;
    setSnapshot({
      scope,
      values: EMPTY_EXPANSION,
      order: [],
      hydrated: true,
    });
  }, [scope]);

  return useMemo(
    () => ({
      expanded: values,
      isExpanded,
      setExpanded,
      toggleExpanded,
      clearExpanded,
      hydrated,
    }),
    [
      hydrated,
      isExpanded,
      setExpanded,
      toggleExpanded,
      clearExpanded,
      values,
    ],
  );
}
