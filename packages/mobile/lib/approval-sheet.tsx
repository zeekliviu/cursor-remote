import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import * as Haptics from "expo-haptics";
import type {
  Confirmation,
  ConfirmationAction,
} from "@cursor-remote/shared";
import {
  approvalActionIntent,
  orderApprovalActions,
} from "./approval-semantics";
import { useReducedMotion } from "./reduced-motion";

const SHEET_TRAVEL = 520;

/**
 * The daemon can add these fields without forcing mobile to wait for the shared
 * package update. They remain optional so today's Confirmation objects are valid.
 */
type ApprovalAction = Confirmation["actions"][number] & {
  intent?: string;
};

type ApprovalConfirmation = Confirmation & {
  kind?: string;
  risk?: ConfirmationAction["risk"];
  resource?: string;
  actions: ApprovalAction[];
};

export type ApprovalSheetProps = {
  open: boolean;
  confirmations: ApprovalConfirmation[];
  onClose: () => void;
  onAction: (confirmationId: string, actionId: string) => Promise<unknown>;
};

function displayKind(item: ApprovalConfirmation): string {
  const value = item.kind?.trim();
  if (!value) return item.command ? "Command" : "Confirmation";
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function displayRisk(item: ApprovalConfirmation): ConfirmationAction["risk"] {
  if (item.risk) return item.risk;
  const rank: Record<ConfirmationAction["risk"], number> = {
    low: 0,
    medium: 1,
    high: 2,
  };
  return item.actions.reduce<ConfirmationAction["risk"]>(
    (highest, action) => (rank[action.risk] > rank[highest] ? action.risk : highest),
    "low",
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "The action could not be sent. Check the connection and try again.";
}

export function ApprovalSheet({
  open,
  confirmations,
  onClose,
  onAction,
}: ApprovalSheetProps) {
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  const [index, setIndex] = useState(0);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(() => new Set());
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const anim = useRef(new Animated.Value(0)).current;
  const confirmationsRef = useRef(confirmations);
  const resolvedIdsRef = useRef(resolvedIds);

  confirmationsRef.current = confirmations;
  resolvedIdsRef.current = resolvedIds;

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    const animation = Animated.timing(anim, {
      toValue: open ? 1 : 0,
      duration: reducedMotion ? 0 : open ? 240 : 170,
      easing: open ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !open) setMounted(false);
    });
    return () => animation.stop();
  }, [anim, mounted, open, reducedMotion]);

  useEffect(() => {
    if (open) return;
    const empty = new Set<string>();
    resolvedIdsRef.current = empty;
    setResolvedIds(empty);
    setIndex(0);
    setPendingActionId(null);
    setActionError(null);
  }, [open]);

  const queue = useMemo(
    () => confirmations.filter((item) => !resolvedIds.has(item.id)),
    [confirmations, resolvedIds],
  );

  useEffect(() => {
    setIndex((current) => Math.min(current, Math.max(0, queue.length - 1)));
  }, [queue.length]);

  const current = queue[index] ?? null;
  const risk = current ? displayRisk(current) : "low";

  const requestClose = useCallback(() => {
    if (pendingActionId) return;
    onClose();
  }, [onClose, pendingActionId]);

  const performAction = useCallback(
    async (confirmation: ApprovalConfirmation, action: ApprovalAction) => {
      if (pendingActionId) return;
      setPendingActionId(action.id);
      setActionError(null);
      void Haptics.selectionAsync().catch(() => undefined);

      try {
        await onAction(confirmation.id, action.id);
        void Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        ).catch(() => undefined);

        const nextResolved = new Set(resolvedIdsRef.current);
        nextResolved.add(confirmation.id);
        resolvedIdsRef.current = nextResolved;
        setResolvedIds(nextResolved);

        const remaining = confirmationsRef.current.filter(
          (item) => !nextResolved.has(item.id),
        );
        setIndex((currentIndex) =>
          Math.min(currentIndex, Math.max(0, remaining.length - 1)),
        );
        if (!remaining.length) onClose();
      } catch (error) {
        void Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Error,
        ).catch(() => undefined);
        setActionError(errorMessage(error));
      } finally {
        setPendingActionId(null);
      }
    },
    [onAction, onClose, pendingActionId],
  );

  const requestAction = useCallback(
    (confirmation: ApprovalConfirmation, action: ApprovalAction) => {
      if (pendingActionId) return;
      if (approvalActionIntent(action) !== "allowAlways") {
        void performAction(confirmation, action);
        return;
      }

      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(
        () => undefined,
      );
      const resource = confirmation.resource?.trim();
      Alert.alert(
        `Confirm ${action.label}`,
        `This persistent permission will allow matching requests without asking again.${
          resource ? `\n\nResource: ${resource}` : ""
        }`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: action.label,
            onPress: () => void performAction(confirmation, action),
          },
        ],
      );
    },
    [pendingActionId, performAction],
  );

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
            disabled={!!pendingActionId}
            accessibilityRole="button"
            accessibilityLabel="Close approvals"
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
          accessibilityViewIsModal
        >
          <View style={styles.grabber} />

          <View style={styles.header}>
            <Text style={styles.title} accessibilityRole="header">
              Approval
            </Text>
            <Pressable
              style={({ pressed }) => [
                styles.closeButton,
                pressed && styles.pressed,
              ]}
              onPress={requestClose}
              disabled={!!pendingActionId}
              accessibilityRole="button"
              accessibilityLabel="Close approvals"
              accessibilityState={{ disabled: !!pendingActionId }}
            >
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>

          <View style={styles.pagingRow}>
            <Text style={styles.count} accessibilityLiveRegion="polite">
              {queue.length ? `${index + 1} of ${queue.length}` : "No requests"}
            </Text>
            <View style={styles.pagingControls}>
              <Pressable
                style={({ pressed }) => [
                  styles.pageButton,
                  index === 0 && styles.controlDisabled,
                  pressed && index > 0 && styles.pressed,
                ]}
                onPress={() => {
                  setActionError(null);
                  setIndex((value) => Math.max(0, value - 1));
                  void Haptics.selectionAsync().catch(() => undefined);
                }}
                disabled={index === 0 || !!pendingActionId}
                accessibilityRole="button"
                accessibilityLabel="Previous approval"
                accessibilityState={{
                  disabled: index === 0 || !!pendingActionId,
                }}
              >
                <Text style={styles.pageIcon}>‹</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.pageButton,
                  index >= queue.length - 1 && styles.controlDisabled,
                  pressed && index < queue.length - 1 && styles.pressed,
                ]}
                onPress={() => {
                  setActionError(null);
                  setIndex((value) => Math.min(queue.length - 1, value + 1));
                  void Haptics.selectionAsync().catch(() => undefined);
                }}
                disabled={index >= queue.length - 1 || !!pendingActionId}
                accessibilityRole="button"
                accessibilityLabel="Next approval"
                accessibilityState={{
                  disabled:
                    index >= queue.length - 1 || !!pendingActionId,
                }}
              >
                <Text style={styles.pageIcon}>›</Text>
              </Pressable>
            </View>
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {current ? (
              <View style={styles.card}>
                <View style={styles.badgeRow}>
                  <View style={styles.categoryBadge}>
                    <Text style={styles.categoryText}>{displayKind(current)}</Text>
                  </View>
                  <View
                    style={[
                      styles.riskBadge,
                      risk === "medium" && styles.riskMedium,
                      risk === "high" && styles.riskHigh,
                    ]}
                  >
                    <Text
                      style={[
                        styles.riskText,
                        risk === "medium" && styles.riskTextMedium,
                        risk === "high" && styles.riskTextHigh,
                      ]}
                    >
                      {risk} risk
                    </Text>
                  </View>
                </View>

                <Text style={styles.requestTitle} selectable>
                  {current.text || "Approval request"}
                </Text>

                {current.resource ? (
                  <View style={styles.section}>
                    <Text style={styles.sectionLabel}>Resource</Text>
                    <Text style={styles.resource} selectable>
                      {current.resource}
                    </Text>
                  </View>
                ) : null}

                {current.summary ? (
                  <View style={styles.section}>
                    <Text style={styles.sectionLabel}>Summary</Text>
                    <Text style={styles.body} selectable>
                      {current.summary}
                    </Text>
                  </View>
                ) : null}

                {current.command ? (
                  <View style={styles.section}>
                    <Text style={styles.sectionLabel}>Command</Text>
                    <View style={styles.commandBox}>
                      <Text style={styles.command} selectable>
                        {current.command}
                      </Text>
                    </View>
                  </View>
                ) : null}
              </View>
            ) : (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>No pending approvals</Text>
                <Text style={styles.emptyBody}>
                  New requests will appear here when Cursor needs a decision.
                </Text>
              </View>
            )}
          </ScrollView>

          {current ? (
            <View style={styles.footer}>
              {actionError ? (
                <Text style={styles.error} accessibilityLiveRegion="polite">
                  {actionError}
                </Text>
              ) : null}
              <View style={styles.actions}>
                {orderApprovalActions(current.actions).map((action) => {
                  const semantic = approvalActionIntent(action);
                  const isPending = pendingActionId === action.id;
                  const disabled = pendingActionId !== null;
                  return (
                    <Pressable
                      key={action.id}
                      style={({ pressed }) => [
                        styles.action,
                        semantic === "allowOnce" && styles.actionAllow,
                        semantic === "allowAlways" && styles.actionAlways,
                        semantic === "deny" && styles.actionDeny,
                        semantic === "allowOnce" &&
                          action.risk === "high" &&
                          styles.actionHigh,
                        disabled && !isPending && styles.controlDisabled,
                        pressed && !disabled && styles.pressed,
                      ]}
                      onPress={() => requestAction(current, action)}
                      disabled={disabled}
                      accessibilityRole="button"
                      accessibilityLabel={action.label}
                      accessibilityHint={
                        semantic === "allowAlways"
                          ? "Requires confirmation and applies to matching future requests."
                          : undefined
                      }
                      accessibilityState={{ disabled, busy: isPending }}
                    >
                      {isPending ? (
                        <ActivityIndicator
                          size="small"
                          color={
                            semantic === "allowOnce" ? "#f7f4ee" : "#4a443b"
                          }
                        />
                      ) : null}
                      <Text
                        style={[
                          styles.actionText,
                          semantic === "allowOnce" && styles.actionTextOn,
                        ]}
                      >
                        {action.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : null}
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
    maxHeight: "90%",
    paddingTop: 8,
    paddingHorizontal: 16,
    backgroundColor: "#f7f4ee",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
  },
  grabber: {
    alignSelf: "center",
    width: 38,
    height: 4,
    marginBottom: 6,
    borderRadius: 2,
    backgroundColor: "#ddd6c8",
  },
  header: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: { color: "#1c1915", fontSize: 19, fontWeight: "700" },
  closeButton: {
    minWidth: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
    borderRadius: 12,
  },
  closeText: { color: "#6f685c", fontSize: 13, fontWeight: "700" },
  pagingRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  count: {
    color: "#8a8378",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  pagingControls: { flexDirection: "row", gap: 8 },
  pageButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    backgroundColor: "#ebe4d6",
  },
  pageIcon: {
    marginTop: -2,
    color: "#4a443b",
    fontSize: 27,
    lineHeight: 29,
    fontWeight: "500",
  },
  scroll: { flexShrink: 1 },
  scrollContent: { paddingBottom: 8 },
  card: {
    padding: 14,
    borderWidth: 1,
    borderColor: "#e5dfd2",
    borderRadius: 16,
    backgroundColor: "#fffdf8",
  },
  badgeRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 12,
  },
  categoryBadge: {
    minHeight: 26,
    justifyContent: "center",
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: "#ebe4d6",
  },
  categoryText: { color: "#4a443b", fontSize: 11, fontWeight: "700" },
  riskBadge: {
    minHeight: 26,
    justifyContent: "center",
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: "#d8e2d5",
    borderRadius: 999,
    backgroundColor: "#edf3eb",
  },
  riskMedium: { borderColor: "#e7d6b7", backgroundColor: "#f6eedf" },
  riskHigh: { borderColor: "#e3c8bf", backgroundColor: "#f5e9e4" },
  riskText: {
    color: "#48604b",
    fontSize: 11,
    fontWeight: "700",
    textTransform: "capitalize",
  },
  riskTextMedium: { color: "#7a5728" },
  riskTextHigh: { color: "#7b4035" },
  requestTitle: {
    color: "#1c1915",
    fontSize: 17,
    lineHeight: 23,
    fontWeight: "700",
  },
  section: { marginTop: 16 },
  sectionLabel: {
    marginBottom: 6,
    color: "#8a8378",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  resource: { color: "#3d382f", fontSize: 14, lineHeight: 20, fontWeight: "600" },
  body: { color: "#4a443b", fontSize: 14, lineHeight: 20 },
  commandBox: {
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: "#e5dfd2",
    borderRadius: 12,
    backgroundColor: "#f3f0e8",
  },
  command: {
    color: "#302c26",
    fontSize: 13,
    lineHeight: 19,
    fontFamily: "monospace",
  },
  empty: {
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 36,
  },
  emptyTitle: { color: "#1c1915", fontSize: 15, fontWeight: "700" },
  emptyBody: {
    marginTop: 6,
    color: "#6f685c",
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
  },
  footer: {
    gap: 8,
    marginTop: 4,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e5dfd2",
  },
  error: { color: "#8a452f", fontSize: 12, lineHeight: 17 },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  action: {
    minWidth: 120,
    minHeight: 48,
    flexBasis: "45%",
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "#ddd6c8",
    borderRadius: 14,
    backgroundColor: "#ebe4d6",
  },
  actionAllow: {
    borderColor: "#1c1915",
    backgroundColor: "#1c1915",
  },
  actionAlways: {
    borderColor: "#ddc79f",
    backgroundColor: "#f3ead9",
  },
  actionDeny: {
    borderColor: "#dfcfc8",
    backgroundColor: "#f1e7e2",
  },
  actionHigh: {
    borderColor: "#633b32",
    backgroundColor: "#633b32",
  },
  actionText: {
    flexShrink: 1,
    color: "#3d382f",
    fontSize: 14,
    fontWeight: "700",
    textAlign: "center",
  },
  actionTextOn: { color: "#f7f4ee" },
  controlDisabled: { opacity: 0.42 },
  pressed: { opacity: 0.72 },
});
