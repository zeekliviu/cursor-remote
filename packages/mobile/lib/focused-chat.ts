import AsyncStorage from "@react-native-async-storage/async-storage";

const LAST_CHAT_KEY = "cursor-remote:last-chat.v1";

export type ChatRef = {
  id: string;
  projectId?: string;
  name?: string;
};

let focused: ChatRef | null = null;
let remembered: ChatRef | null = null;
const listeners = new Set<(ref: ChatRef | null) => void>();

function emit(): void {
  for (const fn of listeners) fn(focused);
}

/**
 * The chat screen registers itself here so background watchers can tell the
 * difference between "user is already looking at this" and "worth a notification".
 */
export function setFocusedChat(ref: ChatRef): void {
  if (!ref.id) return;
  focused = ref;
  rememberChat(ref);
  emit();
}

export function clearFocusedChat(id: string): void {
  if (focused?.id !== id) return;
  focused = null;
  emit();
}

export function getFocusedChat(): ChatRef | null {
  return focused;
}

export function isFocusedChat(id?: string | null): boolean {
  return Boolean(id && focused?.id === id);
}

export function subscribeFocusedChat(
  fn: (ref: ChatRef | null) => void,
): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Last chat the user actually opened — used for notification copy and deep links. */
export function rememberChat(ref: ChatRef): void {
  if (!ref.id) return;
  remembered =
    remembered?.id === ref.id ? { ...remembered, ...ref } : { ...ref };
  AsyncStorage.setItem(LAST_CHAT_KEY, JSON.stringify(remembered)).catch(
    () => undefined,
  );
}

export function getRememberedChat(): ChatRef | null {
  return remembered;
}

export async function hydrateRememberedChat(): Promise<ChatRef | null> {
  if (remembered) return remembered;
  try {
    const raw = await AsyncStorage.getItem(LAST_CHAT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ChatRef;
      if (parsed?.id) remembered = parsed;
    }
  } catch {
    // ignore corrupt storage
  }
  return remembered;
}
