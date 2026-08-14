import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";
import type { ModelChoice, ModelParamSection } from "@cursor-remote/shared";
import { useConnection } from "./connection";
import { useComposerWatch } from "./composer-watch";

/**
 * Reading Cursor's model menu means driving its real UI over CDP, so the list is
 * cached per host: the sheet opens on remembered data and only talks to the host
 * when the user asks for it or the cache has gone stale. Picking a row is local —
 * nothing reaches Cursor until "Set model", which applies model + options in one go.
 */
const CACHE_VERSION = "v1";
const STALE_MS = 6 * 60 * 60 * 1000;
/** Sheet starts this far below its resting position. */
const SHEET_TRAVEL = 520;

type CachedMenu = {
  models: ModelChoice[];
  current?: string;
  params: Record<string, ModelParamSection[]>;
  at: number;
};

const cacheKey = (hostId: string) =>
  `cursor-remote:model-menu:${CACHE_VERSION}:${hostId}`;

function clean(label: string): string {
  return label
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cursor's picker trigger carries suffixes ("sonnet · 1M"); menu rows don't. */
function baseLabel(label?: string | null): string {
  if (!label) return "";
  return clean(label).split(/[·•|,]/)[0]?.trim() || "";
}

const key = (label?: string | null): string => baseLabel(label).toLowerCase();

/** Shared with the composer chip so both shorten the same way. */
export function shortModelLabel(label?: string | null): string {
  const base = baseLabel(label);
  return base ? base.slice(0, 14) : "Model";
}

function matchModel(
  models: ModelChoice[],
  label?: string | null,
): ModelChoice | null {
  const target = key(label);
  if (!target) return null;
  const exact = models.find((m) => key(m.label) === target);
  if (exact) return exact;
  // Trigger text and menu text can drift; prefer the longest overlapping label so
  // "gpt-5" can't shadow "gpt-5.4".
  let best: ModelChoice | null = null;
  for (const m of models) {
    const k = key(m.label);
    if (!k || (!k.includes(target) && !target.includes(k))) continue;
    if (!best || k.length > key(best.label).length) best = m;
  }
  return best;
}

/**
 * Cursor menu rows often omit the vendor ("Sonnet 4.5", "o4-mini", "Gemini 2.5").
 * Match popular tokens anywhere in the label — never dump Anthropic under "Other".
 */
const VENDOR_RULES: Array<[RegExp, string]> = [
  [/^auto$/i, "Auto"],
  [/\b(claude|anthropic|sonnet|opus|haiku|fable)\b/i, "Anthropic"],
  [/\b(gpt|openai|codex|chatgpt)\b/i, "OpenAI"],
  [/\bo[1-9]([\s.\-]|$)/i, "OpenAI"],
  [/\b(gemini|gemma|google)\b/i, "Google"],
  [/\b(grok|xai)\b/i, "xAI"],
  [/\b(composer|cursor)\b/i, "Cursor"],
  [/\b(deepseek)\b/i, "DeepSeek"],
  [/\b(kimi|moonshot)\b/i, "Moonshot"],
  // Prefer versioned GLM tokens so random substrings never collide.
  [/\b(chatglm|glm-\d|glm\s*\d)\b/i, "Zhipu"],
  [/\b(llama|meta-llama)\b/i, "Meta"],
  [/\b(mistral|mixtral|codestral|pixtral)\b/i, "Mistral"],
  [/\b(qwen|qwq)\b/i, "Alibaba"],
];

/** Stable section order (only vendors that appear are shown). */
const VENDOR_ORDER = [
  "Auto",
  "Anthropic",
  "OpenAI",
  "Google",
  "xAI",
  "Cursor",
  "DeepSeek",
  "Moonshot",
  "Zhipu",
  "Meta",
  "Mistral",
  "Alibaba",
];

function vendorOf(label: string): string | null {
  const base = baseLabel(label);
  if (!base) return null;
  for (const [re, name] of VENDOR_RULES) {
    if (re.test(base)) return name;
  }
  return null;
}

function groupModels(
  models: ModelChoice[],
): Array<{ name: string; items: ModelChoice[] }> {
  const byVendor = new Map<string, ModelChoice[]>();
  const unmatched: ModelChoice[] = [];
  for (const m of models) {
    const vendor = vendorOf(m.label);
    if (!vendor) {
      unmatched.push(m);
      continue;
    }
    const bucket = byVendor.get(vendor);
    if (bucket) bucket.push(m);
    else byVendor.set(vendor, [m]);
  }
  const groups: Array<{ name: string; items: ModelChoice[] }> = [];
  for (const name of VENDOR_ORDER) {
    const items = byVendor.get(name);
    if (items?.length) groups.push({ name, items });
  }
  for (const [name, items] of byVendor) {
    if (!VENDOR_ORDER.includes(name) && items.length) {
      groups.push({ name, items });
    }
  }
  // Rare unknowns: flat rows after known vendors — no fake "Other" label.
  // (Solo-title hide used to make these look like part of the previous vendor.)
  if (unmatched.length) {
    groups.push({ name: "", items: unmatched });
  }
  return groups;
}

function initialFromSections(sections: ModelParamSection[]): {
  choices: Record<string, string>;
  toggles: Record<string, boolean>;
} {
  const choices: Record<string, string> = {};
  const toggles: Record<string, boolean> = {};
  for (const section of sections) {
    if (section.kind === "choice") {
      const sel = section.options.find((o) => o.selected);
      if (sel) choices[section.title] = sel.label;
    } else {
      for (const o of section.options) toggles[o.label] = o.selected;
    }
  }
  return { choices, toggles };
}

/** Order-stable fingerprint of the option panel, for "did anything change?". */
function stateKey(
  sections: ModelParamSection[],
  choices: Record<string, string>,
  toggles: Record<string, boolean>,
): string {
  return sections
    .map((s) =>
      s.kind === "choice"
        ? `${s.title}=${choices[s.title] ?? ""}`
        : s.options.map((o) => `${o.label}:${toggles[o.label] ? 1 : 0}`).join(","),
    )
    .join("|");
}

export function ModelPickerSheet({
  open,
  hostModelLabel,
  cdpOk,
  onClose,
  onApplied,
}: {
  open: boolean;
  /** What Cursor's own picker shows right now, straight from the activity poll. */
  hostModelLabel: string | null;
  cdpOk: boolean;
  onClose: () => void;
  onApplied: (label: string) => void;
}) {
  const { client, connection } = useConnection();
  const { toast } = useComposerWatch();
  const insets = useSafeAreaInsets();
  const hostId = connection?.id ?? null;

  const [mounted, setMounted] = useState(false);
  const anim = useRef(new Animated.Value(0)).current;

  const [hydrated, setHydrated] = useState(false);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [paramsByModel, setParamsByModel] = useState<
    Record<string, ModelParamSection[]>
  >({});
  const [cachedAt, setCachedAt] = useState(0);

  const [selected, setSelected] = useState<string | null>(null);
  const [sections, setSections] = useState<ModelParamSection[]>([]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [toggles, setToggles] = useState<Record<string, boolean>>({});
  const [baseline, setBaseline] = useState("");

  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [listError, setListError] = useState(false);
  const [staleNote, setStaleNote] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const latest = useRef({
    models,
    paramsByModel,
    cachedAt,
    selected,
    sections,
    choices,
    toggles,
    baseline,
  });
  latest.current = {
    models,
    paramsByModel,
    cachedAt,
    selected,
    sections,
    choices,
    toggles,
    baseline,
  };

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    const animation = Animated.timing(anim, {
      toValue: open ? 1 : 0,
      duration: open ? 240 : 170,
      easing: open ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !open) setMounted(false);
    });
    return () => animation.stop();
  }, [anim, mounted, open]);

  const persist = useCallback(
    (next: CachedMenu) => {
      if (!hostId) return;
      void AsyncStorage.setItem(cacheKey(hostId), JSON.stringify(next)).catch(
        () => undefined,
      );
    },
    [hostId],
  );

  useEffect(() => {
    setHydrated(false);
    setModels([]);
    setParamsByModel({});
    setCachedAt(0);
    if (!hostId) {
      setHydrated(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      const raw = await AsyncStorage.getItem(cacheKey(hostId)).catch(
        () => null,
      );
      if (cancelled) return;
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as CachedMenu;
          if (Array.isArray(parsed?.models) && parsed.models.length) {
            setModels(parsed.models);
            setParamsByModel(parsed.params || {});
            setCachedAt(parsed.at || 0);
          }
        } catch {
          // corrupt cache — fall through and re-read from the host
        }
      }
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [hostId]);

  const selectLabel = useCallback((label: string) => {
    const next = baseLabel(label);
    const known = latest.current.paramsByModel[key(next)] || [];
    const init = initialFromSections(known);
    setSelected(next);
    setSections(known);
    setChoices(init.choices);
    setToggles(init.toggles);
    setBaseline(stateKey(known, init.choices, init.toggles));
    setApplyError(null);
  }, []);

  const refresh = useCallback(
    async (silent: boolean) => {
      if (!client) return;
      if (silent) setRefreshing(true);
      else {
        setLoading(true);
        setListError(false);
      }
      try {
        const r = await client.models();
        const list = r.models?.length ? r.models : [];
        if (!list.length) throw new Error("no models");
        const current = matchModel(list, r.current)?.label || baseLabel(r.current);
        const nextParams = { ...latest.current.paramsByModel };
        if (current && r.params?.sections?.length) {
          nextParams[key(current)] = r.params.sections;
        }
        const at = Date.now();
        setModels(list);
        setParamsByModel(nextParams);
        setCachedAt(at);
        setListError(false);
        setStaleNote(false);
        persist({ models: list, current, params: nextParams, at });

        // Live options win, but never over something the user already tweaked.
        const untouched =
          stateKey(
            latest.current.sections,
            latest.current.choices,
            latest.current.toggles,
          ) === latest.current.baseline;
        const sel = latest.current.selected || (untouched ? current : "");
        const fresh = sel ? nextParams[key(sel)] : undefined;
        if (sel && fresh && untouched) {
          const init = initialFromSections(fresh);
          setSelected(sel);
          setSections(fresh);
          setChoices(init.choices);
          setToggles(init.toggles);
          setBaseline(stateKey(fresh, init.choices, init.toggles));
        } else if (!latest.current.selected && current) {
          setSelected(current);
        }
      } catch {
        if (latest.current.models.length) setStaleNote(true);
        else setListError(true);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [client, persist],
  );

  // Seed once per open — the host label keeps ticking in and must not stomp a pick.
  const seeded = useRef(false);
  useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    if (!hydrated || seeded.current) return;
    seeded.current = true;
    setApplyError(null);
    setStaleNote(false);
    const host = baseLabel(hostModelLabel);
    const resolved = matchModel(latest.current.models, host)?.label || host;
    if (resolved) selectLabel(resolved);
    if (!latest.current.models.length) void refresh(false);
    else if (Date.now() - latest.current.cachedAt > STALE_MS) void refresh(true);
  }, [hostModelLabel, hydrated, open, refresh, selectLabel]);

  /** First time a model is used, remember which options Cursor offers for it. */
  const learnParams = useCallback(
    async (label: string) => {
      if (!client || latest.current.paramsByModel[key(label)]?.length) return;
      try {
        const p = await client.modelParams();
        if (!p?.sections?.length) return;
        const nextParams = {
          ...latest.current.paramsByModel,
          [key(label)]: p.sections,
        };
        setParamsByModel(nextParams);
        persist({
          models: latest.current.models,
          current: label,
          params: nextParams,
          at: latest.current.cachedAt || Date.now(),
        });
      } catch {
        // best effort — the options simply stay unknown until next time
      }
    },
    [client, persist],
  );

  const apply = useCallback(async () => {
    const label = latest.current.selected;
    if (!client || !label) return;
    const outChoices: Record<string, string> = {};
    const outToggles: Record<string, boolean> = {};
    for (const section of latest.current.sections) {
      if (section.kind === "choice") {
        const value = latest.current.choices[section.title];
        if (value) outChoices[section.title] = value;
      } else {
        for (const o of section.options) {
          outToggles[o.label] = !!latest.current.toggles[o.label];
        }
      }
    }
    setApplying(true);
    setApplyError(null);
    try {
      const { ok } = await client.selectModel(label, undefined, undefined, {
        choices: outChoices,
        toggles: outToggles,
      });
      if (!ok) {
        setApplyError(
          "Cursor didn't switch models. Bring the composer into view on your host and try again.",
        );
        return;
      }
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
        () => undefined,
      );
      toast(`Model · ${label}`);
      onApplied(label);
      void learnParams(label);
    } catch {
      setApplyError("Couldn't reach your host. Check the connection and retry.");
    } finally {
      setApplying(false);
    }
  }, [client, learnParams, onApplied, toast]);

  const groups = useMemo(() => groupModels(models), [models]);
  const hostKey = key(hostModelLabel);
  const isAuto = /^auto$/i.test(selected || "");
  const onHost = Boolean(selected) && key(selected) === hostKey;
  const modelChanged = Boolean(selected) && !onHost;
  const optionsChanged = stateKey(sections, choices, toggles) !== baseline;
  const dirty = modelChanged || optionsChanged;
  const blocked = dirty && !cdpOk;
  const primaryLabel = applying
    ? "Setting…"
    : !dirty
      ? "Done"
      : modelChanged
        ? "Set model"
        : "Save options";

  const requestClose = useCallback(() => {
    if (applying) return;
    onClose();
  }, [applying, onClose]);

  const translateY = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [SHEET_TRAVEL, 0],
  });

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={requestClose}
    >
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, { opacity: anim }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={requestClose}
            accessibilityLabel="Close model picker"
          />
        </Animated.View>

        <Animated.View
          style={[
            styles.sheet,
            {
              paddingBottom: Math.max(insets.bottom, 14),
              transform: [{ translateY }],
            },
          ]}
        >
          <View style={styles.grabber} />

          <View style={styles.headerRow}>
            <Text style={styles.title}>Model</Text>
            <Pressable
              style={({ pressed }) => [
                styles.refreshBtn,
                pressed && styles.pressed,
              ]}
              onPress={() => void refresh(models.length > 0)}
              disabled={loading || refreshing}
              hitSlop={8}
              accessibilityLabel="Reload models from Cursor"
            >
              {loading || refreshing ? (
                <ActivityIndicator size="small" color="#6f685c" />
              ) : (
                <Text style={styles.refreshIcon}>↻</Text>
              )}
            </Pressable>
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.card}>
              <Text style={styles.cardModel} numberOfLines={2}>
                {selected || "No model yet"}
              </Text>
              <View style={styles.statusRow}>
                {onHost ? (
                  <>
                    <View style={styles.statusDot} />
                    <Text style={styles.statusOn}>Active in Cursor</Text>
                  </>
                ) : (
                  <Text style={styles.statusOff}>
                    {selected ? "Not active yet" : "Pick one below"}
                  </Text>
                )}
              </View>

              {sections.map((section) => (
                <View key={section.id} style={styles.section}>
                  <Text style={styles.sectionLabel}>{section.title}</Text>
                  <View style={styles.chipRow}>
                    {section.options.map((opt) => {
                      const on =
                        section.kind === "choice"
                          ? choices[section.title] === opt.label
                          : !!toggles[opt.label];
                      return (
                        <Pressable
                          key={opt.id}
                          style={({ pressed }) => [
                            styles.chip,
                            on && styles.chipOn,
                            pressed && styles.pressed,
                          ]}
                          onPress={() => {
                            void Haptics.selectionAsync().catch(() => undefined);
                            if (section.kind === "choice") {
                              setChoices((s) => ({
                                ...s,
                                [section.title]: opt.label,
                              }));
                            } else {
                              setToggles((s) => ({
                                ...s,
                                [opt.label]: !s[opt.label],
                              }));
                            }
                          }}
                        >
                          <Text
                            style={[styles.chipText, on && styles.chipTextOn]}
                          >
                            {opt.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ))}

              {isAuto ? (
                <Text style={styles.hint}>
                  Cursor picks a model for each message.
                </Text>
              ) : !sections.length && selected ? (
                <Text style={styles.hint}>
                  Options for this model appear once it has been set.
                </Text>
              ) : null}
            </View>

            {!models.length && (loading || (!listError && !!client)) ? (
              <View style={styles.calmBlock}>
                <ActivityIndicator color="#6f685c" />
                <Text style={styles.calmBody}>Reading Cursor's model list…</Text>
              </View>
            ) : !models.length ? (
              <View style={styles.calmBlock}>
                <Text style={styles.calmTitle}>Model list unavailable</Text>
                <Text style={styles.calmBody}>
                  Open Cursor on your host with a chat visible, then try again.
                </Text>
                <Pressable
                  style={({ pressed }) => [
                    styles.secondary,
                    pressed && styles.pressed,
                  ]}
                  onPress={() => void refresh(false)}
                >
                  <Text style={styles.secondaryText}>Try again</Text>
                </Pressable>
              </View>
            ) : (
              <>
                <View style={styles.listHeader}>
                  <Text style={styles.listTitle}>All models</Text>
                  {staleNote ? (
                    <Text style={styles.listNote}>last known list</Text>
                  ) : null}
                </View>
                {groups.map((group) => {
                  const hideTitle =
                    !group.name ||
                    group.name === "Auto" ||
                    (group.items.length === 1 &&
                      key(group.items[0]?.label) === group.name.toLowerCase() &&
                      VENDOR_ORDER.includes(group.name));
                  return (
                    <View
                      key={group.name || `u-${group.items[0]?.id}`}
                      style={styles.group}
                    >
                      {hideTitle ? null : (
                        <Text style={styles.groupTitle}>{group.name}</Text>
                      )}
                      {group.items.map((m) => {
                        const isSelected = key(m.label) === key(selected);
                        const isHost = key(m.label) === hostKey;
                        return (
                          <Pressable
                            key={m.id}
                            style={({ pressed }) => [
                              styles.row,
                              isSelected && styles.rowOn,
                              pressed && styles.rowPressed,
                            ]}
                            onPress={() => {
                              void Haptics.selectionAsync().catch(
                                () => undefined,
                              );
                              selectLabel(m.label);
                            }}
                          >
                            <Text
                              style={[
                                styles.rowText,
                                isSelected && styles.rowTextOn,
                              ]}
                              numberOfLines={1}
                            >
                              {m.label}
                            </Text>
                            {isSelected ? (
                              <Text style={styles.rowCheck}>✓</Text>
                            ) : isHost ? (
                              <Text style={styles.rowHost}>in Cursor</Text>
                            ) : null}
                          </Pressable>
                        );
                      })}
                    </View>
                  );
                })}
              </>
            )}
          </ScrollView>

          <View style={styles.footer}>
            {applyError ? (
              <Text style={styles.footerNote}>{applyError}</Text>
            ) : blocked ? (
              <Text style={styles.footerNote}>
                Cursor is disconnected — reconnect to change the model.
              </Text>
            ) : null}
            <Pressable
              style={({ pressed }) => [
                styles.primary,
                (applying || blocked) && styles.primaryOff,
                pressed && styles.pressed,
              ]}
              disabled={applying || blocked}
              onPress={() => {
                if (!dirty) {
                  onClose();
                  return;
                }
                void apply();
              }}
            >
              {applying ? <ActivityIndicator size="small" color="#f7f4ee" /> : null}
              <Text
                style={[
                  styles.primaryText,
                  (applying || blocked) && styles.primaryTextOff,
                ]}
              >
                {primaryLabel}
              </Text>
            </Pressable>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(28,25,21,0.42)",
  },
  sheet: {
    backgroundColor: "#f7f4ee",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingTop: 8,
    paddingHorizontal: 16,
    maxHeight: "88%",
  },
  grabber: {
    alignSelf: "center",
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#ddd6c8",
    marginBottom: 10,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  title: { fontSize: 19, fontWeight: "700", color: "#1c1915" },
  refreshBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#ebe4d6",
    alignItems: "center",
    justifyContent: "center",
  },
  refreshIcon: {
    color: "#6f685c",
    fontSize: 17,
    fontWeight: "700",
    marginTop: -1,
  },
  scroll: { flexShrink: 1 },
  scrollContent: { paddingBottom: 8 },
  card: {
    backgroundColor: "#fffdf8",
    borderWidth: 1,
    borderColor: "#e5dfd2",
    borderRadius: 16,
    padding: 14,
  },
  cardModel: { fontSize: 17, fontWeight: "700", color: "#1c1915" },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#2f5d3a",
  },
  statusOn: { color: "#2f5d3a", fontSize: 12, fontWeight: "600" },
  statusOff: { color: "#8a8378", fontSize: 12, fontWeight: "600" },
  section: { marginTop: 14 },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "#8a8378",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "#f3f0e8",
    borderWidth: 1,
    borderColor: "#e5dfd2",
  },
  chipOn: { backgroundColor: "#2f5d3a", borderColor: "#2f5d3a" },
  chipText: { color: "#4a443b", fontSize: 13, fontWeight: "600" },
  chipTextOn: { color: "#f7f4ee" },
  hint: { color: "#8a8378", fontSize: 12, lineHeight: 17, marginTop: 12 },
  calmBlock: {
    alignItems: "center",
    gap: 8,
    paddingVertical: 28,
    paddingHorizontal: 12,
  },
  calmTitle: { color: "#1c1915", fontSize: 15, fontWeight: "700" },
  calmBody: {
    color: "#6f685c",
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
  },
  secondary: {
    marginTop: 4,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: "#ebe4d6",
  },
  secondaryText: { color: "#1c1915", fontSize: 13, fontWeight: "700" },
  listHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginTop: 20,
    marginBottom: 4,
  },
  listTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: "#8a8378",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  listNote: { fontSize: 11, color: "#a09889" },
  group: { marginTop: 10 },
  groupTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: "#a09889",
    marginBottom: 2,
    marginLeft: 12,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: 12,
  },
  rowOn: { backgroundColor: "#ebe4d6" },
  rowPressed: { backgroundColor: "#efeade" },
  rowText: { color: "#3d382f", fontSize: 14, fontWeight: "600", flexShrink: 1 },
  rowTextOn: { color: "#1c1915", fontWeight: "700" },
  rowCheck: { color: "#2f5d3a", fontSize: 15, fontWeight: "700" },
  rowHost: { color: "#8a8378", fontSize: 11, fontWeight: "600" },
  footer: {
    paddingTop: 12,
    marginTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e5dfd2",
    gap: 8,
  },
  footerNote: { color: "#8a5a20", fontSize: 12, lineHeight: 17 },
  primary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#1c1915",
    borderRadius: 14,
    paddingVertical: 14,
  },
  primaryOff: { backgroundColor: "#d5cfc2" },
  primaryText: { color: "#f7f4ee", fontSize: 15, fontWeight: "700" },
  primaryTextOff: { color: "#8a8378" },
  pressed: { opacity: 0.72 },
});
