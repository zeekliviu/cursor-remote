import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ApiClient,
  clearConnection,
  defaultLabel,
  hostIdFor,
  loadHostsState,
  saveHostsState,
  type Connection,
  type HostProfile,
  type HostsState,
} from "./api";

type Ctx = {
  client: ApiClient | null;
  connection: HostProfile | null;
  hosts: HostProfile[];
  ready: boolean;
  /** Add or update a host and make it active. */
  connect: (conn: Connection & { label?: string }) => Promise<HostProfile>;
  /** Switch active host without removing others. */
  switchHost: (id: string) => Promise<void>;
  /** Rename a saved host. */
  renameHost: (id: string, label: string) => Promise<void>;
  /** Remove one host; if it was active, activate another. */
  removeHost: (id: string) => Promise<void>;
  /** Remove all hosts (legacy Unpair-all). */
  disconnect: () => Promise<void>;
};

const ConnectionContext = createContext<Ctx | null>(null);

function activeFrom(state: HostsState): HostProfile | null {
  if (!state.hosts.length) return null;
  return (
    state.hosts.find((h) => h.id === state.activeId) || state.hosts[0] || null
  );
}

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<HostsState>({ hosts: [], activeId: null });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    loadHostsState().then((s) => {
      setState(s);
      setReady(true);
    });
  }, []);

  const persist = useCallback(async (next: HostsState) => {
    setState(next);
    await saveHostsState(next);
  }, []);

  const connection = useMemo(() => activeFrom(state), [state]);

  const connect = useCallback(
    async (conn: Connection & { label?: string }) => {
      const id = conn.id || hostIdFor(conn.host, conn.port);
      const existing = state.hosts.find((h) => h.id === id);
      const profile: HostProfile = {
        id,
        label:
          (conn.label && conn.label.trim()) ||
          existing?.label ||
          defaultLabel(conn.host, conn.port),
        host: conn.host,
        port: conn.port,
        token: conn.token,
        addedAt: existing?.addedAt ?? Date.now(),
      };
      const hosts = [...state.hosts.filter((h) => h.id !== id), profile];
      await persist({ hosts, activeId: id });
      return profile;
    },
    [persist, state.hosts],
  );

  const switchHost = useCallback(
    async (id: string) => {
      if (!state.hosts.some((h) => h.id === id)) return;
      await persist({ ...state, activeId: id });
    },
    [persist, state],
  );

  const renameHost = useCallback(
    async (id: string, label: string) => {
      const trimmed = label.trim();
      if (!trimmed) return;
      const hosts = state.hosts.map((h) =>
        h.id === id ? { ...h, label: trimmed } : h,
      );
      await persist({ ...state, hosts });
    },
    [persist, state],
  );

  const removeHost = useCallback(
    async (id: string) => {
      const hosts = state.hosts.filter((h) => h.id !== id);
      const activeId =
        state.activeId === id ? hosts[0]?.id ?? null : state.activeId;
      await persist({ hosts, activeId });
    },
    [persist, state],
  );

  const disconnect = useCallback(async () => {
    await clearConnection();
    setState({ hosts: [], activeId: null });
  }, []);

  const value = useMemo<Ctx>(
    () => ({
      client: connection ? new ApiClient(connection) : null,
      connection,
      hosts: state.hosts,
      ready,
      connect,
      switchHost,
      renameHost,
      removeHost,
      disconnect,
    }),
    [
      connection,
      state.hosts,
      ready,
      connect,
      switchHost,
      renameHost,
      removeHost,
      disconnect,
    ],
  );

  return (
    <ConnectionContext.Provider value={value}>
      {children}
    </ConnectionContext.Provider>
  );
}

export function useConnection(): Ctx {
  const ctx = useContext(ConnectionContext);
  if (!ctx) throw new Error("ConnectionProvider missing");
  return ctx;
}
