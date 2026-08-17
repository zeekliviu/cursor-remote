import type { ConfirmationAction } from "@cursor-remote/shared";

export type SemanticApprovalAction =
  | "allowOnce"
  | "allowAlways"
  | "deny"
  | "other";

export function approvalActionIntent(
  action: Pick<ConfirmationAction, "label" | "intent">,
): SemanticApprovalAction {
  const explicit = (action.intent || "")
    .replace(/[\s_-]/g, "")
    .toLowerCase();
  if (explicit === "allowalways") return "allowAlways";
  if (explicit === "allowonce") return "allowOnce";
  if (explicit === "deny") return "deny";

  const label = action.label.trim().toLowerCase();
  if (
    /^(always run|run always|allow always|always allow|don'?t ask again)$/.test(
      label,
    )
  ) {
    return "allowAlways";
  }
  if (
    /^(run|run once|allow|allow once|accept|approve|continue|confirm|yes)$/.test(
      label,
    )
  ) {
    return "allowOnce";
  }
  if (/^(deny|reject|cancel|skip|no)$/.test(label)) return "deny";
  return "other";
}

export function orderApprovalActions<T extends ConfirmationAction>(
  actions: readonly T[],
): T[] {
  const rank: Record<SemanticApprovalAction, number> = {
    deny: 0,
    allowOnce: 1,
    other: 2,
    allowAlways: 3,
  };
  return [...actions].sort(
    (left, right) =>
      rank[approvalActionIntent(left)] - rank[approvalActionIntent(right)],
  );
}
