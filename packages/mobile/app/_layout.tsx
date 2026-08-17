import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConnectionProvider } from "../lib/connection";
import { ComposerWatchProvider } from "../lib/composer-watch";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ConnectionProvider>
        <ComposerWatchProvider>
          <StatusBar style="dark" />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: "#f3f0e8" },
              headerTintColor: "#1c1915",
              contentStyle: { backgroundColor: "#f7f4ee" },
            }}
          >
            <Stack.Screen name="index" options={{ title: "Cursor Remote" }} />
            <Stack.Screen name="pair" options={{ title: "Add host" }} />
            <Stack.Screen
              name={"projects/[id]"}
              options={{ title: "Project" }}
            />
            <Stack.Screen name={"chats/[id]"} options={{ title: "Chat" }} />
            <Stack.Screen
              name={"chats/[id]/changes"}
              options={{ title: "Changes" }}
            />
            <Stack.Screen
              name={"terminal/[id]"}
              options={{ title: "Terminal" }}
            />
            <Stack.Screen name={"diff/[id]"} options={{ title: "Diff" }} />
          </Stack>
        </ComposerWatchProvider>
      </ConnectionProvider>
    </SafeAreaProvider>
  );
}
