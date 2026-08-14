import { useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  Alert,
  ActivityIndicator,
} from "react-native";
import { router } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import {
  ApiClient,
  defaultLabel,
  parsePairPayload,
  type Connection,
} from "../lib/api";
import { useConnection } from "../lib/connection";

export default function PairScreen() {
  const { connect, hosts } = useConnection();
  const [label, setLabel] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("7843");
  const [token, setToken] = useState("");
  const [scan, setScan] = useState(true);
  const [busy, setBusy] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const handlingScan = useRef(false);

  async function save(conn: Connection, name?: string) {
    setBusy(true);
    const existed = hosts.some(
      (h) =>
        h.host.toLowerCase() === conn.host.toLowerCase() && h.port === conn.port,
    );
    try {
      const client = new ApiClient(conn);
      await client.projects();
      const profile = await connect({
        ...conn,
        label: (name ?? label).trim() || undefined,
      });
      Alert.alert(
        existed ? "Host updated" : "Host added",
        `${profile.label} is now active.`,
      );
      router.replace("/");
    } catch (err) {
      Alert.alert(
        "Pairing failed",
        `${(err as Error).message}\n\nCheck host/port/token. Token must match the one on http://HOST:7843 (same daemon process).`,
      );
    } finally {
      setBusy(false);
      handlingScan.current = false;
    }
  }

  async function saveFromFields() {
    const conn = {
      host: host.trim(),
      port: Number(port),
      token: token.trim(),
    };
    if (!conn.host || !conn.token || Number.isNaN(conn.port)) {
      Alert.alert("Missing fields", "Host, port, and token are required.");
      return;
    }
    await save(conn, label.trim() || defaultLabel(conn.host, conn.port));
  }

  async function onScan(data: string) {
    if (handlingScan.current || busy) return;
    const parsed = parsePairPayload(data);
    if (!parsed) {
      Alert.alert("Invalid QR", "Expected a Cursor Remote pairing QR from :7843");
      return;
    }
    handlingScan.current = true;
    setScan(false);
    setHost(parsed.host);
    setPort(String(parsed.port));
    setToken(parsed.token);
    await save(
      parsed,
      label.trim() || defaultLabel(parsed.host, parsed.port),
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.help}>
        Open http://&lt;host-ip&gt;:7843 on the computer (Mac or Windows), then
        scan that QR here. Existing hosts stay saved — this adds or updates one
        and switches to it.
      </Text>

      <TextInput
        style={styles.input}
        placeholder="Label (optional) — e.g. MacBook, PC birou"
        value={label}
        onChangeText={setLabel}
      />

      <Pressable
        style={styles.primary}
        onPress={async () => {
          if (!permission?.granted) {
            const res = await requestPermission();
            if (!res.granted) return;
          }
          setScan((v) => !v);
        }}
      >
        <Text style={styles.primaryText}>
          {scan ? "Hide camera" : "Scan pairing QR"}
        </Text>
      </Pressable>

      {scan && permission?.granted ? (
        <CameraView
          style={styles.camera}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => {
            onScan(data);
          }}
        />
      ) : null}

      {busy ? <ActivityIndicator style={{ marginVertical: 8 }} /> : null}

      <Text style={styles.or}>Or enter manually</Text>
      <TextInput
        style={styles.input}
        placeholder="host (e.g. 10.39.42.23)"
        autoCapitalize="none"
        autoCorrect={false}
        value={host}
        onChangeText={setHost}
      />
      <TextInput
        style={styles.input}
        placeholder="port"
        keyboardType="number-pad"
        value={port}
        onChangeText={setPort}
      />
      <TextInput
        style={styles.input}
        placeholder="token"
        autoCapitalize="none"
        autoCorrect={false}
        value={token}
        onChangeText={setToken}
      />
      <Pressable
        style={[styles.secondaryBtn, busy && { opacity: 0.5 }]}
        disabled={busy}
        onPress={saveFromFields}
      >
        <Text style={styles.secondaryBtnText}>
          {hosts.length ? "Add / switch to host" : "Connect"}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 10 },
  help: { color: "#5c564c", marginBottom: 6, lineHeight: 20 },
  input: {
    backgroundColor: "#fffdf8",
    borderWidth: 1,
    borderColor: "#e5dfd2",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
  },
  primary: {
    backgroundColor: "#1c1915",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  primaryText: { color: "#f7f4ee", fontWeight: "600" },
  secondaryBtn: {
    backgroundColor: "#ebe4d6",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 4,
  },
  secondaryBtnText: { color: "#1c1915", fontWeight: "600" },
  camera: { height: 280, borderRadius: 16, overflow: "hidden" },
  or: {
    marginTop: 8,
    color: "#7a7368",
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
});
