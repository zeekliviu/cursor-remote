import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConnectionProvider } from "../lib/connection";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ConnectionProvider>
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
          <Stack.Screen name={"projects/[id]"} options={{ title: "Project" }} />
          <Stack.Screen name={"chats/[id]"} options={{ title: "Chat" }} />
          <Stack.Screen name={"terminal/[id]"} options={{ title: "Terminal" }} />
          <Stack.Screen name={"diff/[id]"} options={{ title: "Diff" }} />
        </Stack>
      </ConnectionProvider>
    </SafeAreaProvider>
  );
}
