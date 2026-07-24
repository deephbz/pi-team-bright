import crypto from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCurrentTeammateSessionBinding } from "./teams";

export const RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT =
  "rarebit-automatic-summary-policy/1";
export const RAREBIT_AUTOMATIC_SUMMARY_POLICY_EVENT =
  "rarebit:automatic-summary-policy-query";
const RESPONSE_VALIDITY_MS = 1_000;

type PolicyQuery = {
  contractVersion: string;
  queryId: string;
  operation: string;
  session: { id: string; durableAssociation: string };
  issuedAt: string;
  deadlineAt: string;
  respond: (response: unknown) => boolean;
};

function string(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function policyQuery(value: unknown): PolicyQuery | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const query = value as Partial<PolicyQuery>;
  if (
    query.contractVersion !== RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT ||
    query.operation !== "automatic_summary" ||
    !string(query.queryId) ||
    !query.session ||
    !string(query.session.id) ||
    !string(query.session.durableAssociation) ||
    !string(query.issuedAt) ||
    !string(query.deadlineAt) ||
    !Number.isFinite(Date.parse(query.issuedAt)) ||
    !Number.isFinite(Date.parse(query.deadlineAt)) ||
    typeof query.respond !== "function"
  )
    return null;
  return query as PolicyQuery;
}

function opaque(kind: string, value: string): string {
  return `${kind}_${crypto.createHash("sha256").update(value).digest("hex")}`;
}

export async function answerAutomaticSummaryPolicyQuery(
  rawQuery: unknown,
  {
    resolveBinding = resolveCurrentTeammateSessionBinding,
    now = () => Date.now(),
  } = {},
): Promise<void> {
  const query = policyQuery(rawQuery);
  if (!query || now() > Date.parse(query.deadlineAt)) return;
  let resolution: Awaited<
    ReturnType<typeof resolveCurrentTeammateSessionBinding>
  >;
  try {
    resolution = await resolveBinding(query.session.durableAssociation);
  } catch {
    return;
  }
  const observedAtMillis = now();
  if (observedAtMillis > Date.parse(query.deadlineAt)) return;
  const common = {
    contractVersion: RAREBIT_AUTOMATIC_SUMMARY_POLICY_CONTRACT,
    queryId: query.queryId,
    provider: "pi-teams",
    observedAt: new Date(observedAtMillis).toISOString(),
    validUntil: new Date(observedAtMillis + RESPONSE_VALIDITY_MS).toISOString(),
  };
  if (resolution.status !== "bound") {
    query.respond({
      ...common,
      decision: "abstain",
      reason: resolution.reason,
    });
    return;
  }
  const membershipId = resolution.member.membershipId;
  const sessionFile = resolution.member.sessionFile;
  if (!membershipId || sessionFile !== query.session.durableAssociation) {
    query.respond({
      ...common,
      decision: "abstain",
      reason: "stale_binding",
    });
    return;
  }
  query.respond({
    ...common,
    decision: "inhibit",
    reason: "current_teammate_membership",
    provenance: {
      identity: opaque("team", resolution.teamName),
      generation: opaque("membership", membershipId),
      association: opaque("session", sessionFile),
    },
  });
}

export function registerAutomaticSummaryPolicyProvider(pi: ExtensionAPI): void {
  pi.events?.on(RAREBIT_AUTOMATIC_SUMMARY_POLICY_EVENT, (query) => {
    void answerAutomaticSummaryPolicyQuery(query);
  });
}
