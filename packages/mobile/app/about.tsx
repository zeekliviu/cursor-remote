import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import Constants from "expo-constants";
import { PRIVACY_POLICY_URL, SUPPORT_URL } from "../lib/legal";

export default function AboutScreen() {
  const version =
    Constants.expoConfig?.version ||
    Constants.nativeAppVersion ||
    "0.1.0";

  return (
    <View style={styles.container}>
      <Text style={styles.brand}>Cursor Remote</Text>
      <Text style={styles.meta}>Version {version}</Text>
      <Text style={styles.body}>
        Phone companion for the Cursor Remote daemon on your Mac or Windows
        host. Chats and files stay on your machine — this app does not run a
        cloud backend.
      </Text>

      <Pressable
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        onPress={() => void Linking.openURL(PRIVACY_POLICY_URL)}
        accessibilityRole="link"
        accessibilityLabel="Open privacy policy"
      >
        <Text style={styles.rowTitle}>Privacy policy</Text>
        <Text style={styles.rowHint}>Opens in browser</Text>
      </Pressable>

      <Pressable
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        onPress={() => void Linking.openURL(SUPPORT_URL)}
        accessibilityRole="link"
        accessibilityLabel="Open support"
      >
        <Text style={styles.rowTitle}>Support / issues</Text>
        <Text style={styles.rowHint}>GitHub</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    gap: 12,
    backgroundColor: "#f7f4ee",
  },
  brand: {
    fontSize: 24,
    fontWeight: "800",
    color: "#1c1915",
  },
  meta: {
    fontSize: 13,
    color: "#6f685c",
    fontWeight: "600",
    marginBottom: 4,
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    color: "#3d3830",
    marginBottom: 8,
  },
  row: {
    backgroundColor: "#fffdf8",
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#ddd4c4",
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  pressed: { opacity: 0.85 },
  rowTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#1c1915",
  },
  rowHint: {
    marginTop: 2,
    fontSize: 12,
    color: "#6f685c",
  },
});
