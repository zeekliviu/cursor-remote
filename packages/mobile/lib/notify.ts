import { Platform } from "react-native";
/**
 * IMPORTANT: never `import … from 'expo-notifications'` (the package barrel).
 * That entry re-exports DevicePushTokenAutoRegistration.fx, which calls
 * addPushTokenListener on load and `console.error`s in Expo Go on Android
 * (SDK 53+ removed remote push from Expo Go). Deep imports keep local
 * notifications working without touching push APIs.
 */
import { setNotificationHandler } from "expo-notifications/build/NotificationsHandler";
import scheduleNotificationAsync from "expo-notifications/build/scheduleNotificationAsync";
import {
  getPermissionsAsync,
  requestPermissionsAsync,
} from "expo-notifications/build/NotificationPermissions";
import setNotificationChannelAsync from "expo-notifications/build/setNotificationChannelAsync";
import { AndroidImportance } from "expo-notifications/build/NotificationChannelManager.types";

const CHANNEL_ID = "agent";

export type NotifyKind = "finished" | "approval";

export type NotifyData = {
  kind: NotifyKind;
  chatId?: string;
  projectId?: string;
};

let handlerInstalled = false;
let granted: boolean | null = null;

function installHandler(): void {
  if (handlerInstalled) return;
  handlerInstalled = true;
  setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

/**
 * Idempotent permission + Android channel setup. Denials are not cached so a
 * user who enables notifications in Settings gets picked up on the next attempt.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (granted) return true;
  try {
    installHandler();
    if (Platform.OS === "android") {
      await setNotificationChannelAsync(CHANNEL_ID, {
        name: "Agent activity",
        importance: AndroidImportance.DEFAULT,
        lightColor: "#2f5d3a",
        vibrationPattern: [0, 120],
      });
    }
    const current = await getPermissionsAsync();
    let ok = current.granted;
    if (!ok && current.canAskAgain !== false) {
      ok = (await requestPermissionsAsync()).granted;
    }
    granted = ok;
    return ok;
  } catch {
    return false;
  }
}

export async function notifyLocal(
  title: string,
  body: string,
  data: NotifyData,
): Promise<void> {
  if (!(await ensureNotificationPermission())) return;
  try {
    await scheduleNotificationAsync({
      content: {
        title,
        body,
        data,
        ...(Platform.OS === "android" ? { channelId: CHANNEL_ID } : {}),
      },
      // Immediate local notification — do not pass a bare { channelId } trigger
      // (invalid shape and can confuse the scheduler).
      trigger: null,
    });
  } catch {
    // never let a notification failure break the UI
  }
}

/** Route payload attached to our notifications, read back on tap. */
export function parseNotifyData(raw: unknown): NotifyData | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Partial<NotifyData>;
  if (d.kind !== "finished" && d.kind !== "approval") return null;
  return {
    kind: d.kind,
    chatId: typeof d.chatId === "string" ? d.chatId : undefined,
    projectId: typeof d.projectId === "string" ? d.projectId : undefined,
  };
}
