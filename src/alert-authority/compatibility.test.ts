import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import extension from "../../extensions/index";
import * as canonicalAlerts from "./alerts";
import * as canonicalDelivery from "./direct-delivery";
import * as canonicalInbox from "./inbox-delivery";
import * as legacyAlerts from "../utils/alerts";
import * as legacyDelivery from "../utils/message-delivery";
import * as legacyInbox from "../utils/messaging";
import type {
  AlertKind as CanonicalAlertKind,
  AlertTaskReference as CanonicalAlertTaskReference,
  SendAlertInput as CanonicalSendAlertInput,
  SendAlertResult as CanonicalSendAlertResult,
} from "./contracts";
import type {
  AlertKind as LegacyAlertKind,
  AlertTaskReference as LegacyAlertTaskReference,
  SendAlertInput as LegacySendAlertInput,
  SendAlertResult as LegacySendAlertResult,
} from "../utils/alerts";
import type {
  DirectMessageBatch as CanonicalDirectMessageBatch,
  DirectMessageDeliverySink as CanonicalDirectMessageDeliverySink,
} from "./contracts";
import type {
  DirectMessageBatch as LegacyDirectMessageBatch,
  DirectMessageDeliverySink as LegacyDirectMessageDeliverySink,
} from "../utils/message-delivery";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type Expect<Value extends true> = Value;

type LegacyAlertExportsRemainCanonical = [
  Expect<Equal<LegacyAlertKind, CanonicalAlertKind>>,
  Expect<Equal<LegacyAlertTaskReference, CanonicalAlertTaskReference>>,
  Expect<Equal<LegacySendAlertInput, CanonicalSendAlertInput>>,
  Expect<Equal<LegacySendAlertResult, CanonicalSendAlertResult>>,
  Expect<Equal<LegacyDirectMessageBatch, CanonicalDirectMessageBatch>>,
  Expect<Equal<LegacyDirectMessageDeliverySink, CanonicalDirectMessageDeliverySink>>,
];
void (null as unknown as LegacyAlertExportsRemainCanonical);

const root = process.cwd();
const compatibilityPaths = new Set([
  path.join(root, "src/utils/alerts.ts"),
  path.join(root, "src/utils/messaging.ts"),
  path.join(root, "src/utils/message-delivery.ts"),
]);

function productionFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(file);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [file] : [];
  });
}

function importSpecifiers(file: string): string[] {
  return [...fs.readFileSync(file, "utf8").matchAll(/from\s+["']([^"']+)["']/g)]
    .map((match) => match[1]);
}

function expectCompatibilityExports(legacy: object, keys: string[]): void {
  expect(Object.keys(legacy).sort()).toEqual(keys);
}

describe("Alert canonical authority compatibility", () => {
  it("keeps legacy utility calls while canonical authority requires ports", () => {
    expectCompatibilityExports(legacyAlerts, ["ALERT_KINDS", "sendAlert"]);
    expectCompatibilityExports(legacyInbox, [
      "MessageTeamDoesNotExistError",
      "RecipientMembershipUnresolvedError",
      "RecipientNotCurrentMemberError",
      "appendMessage",
      "broadcastMessage",
      "markMessagesRead",
      "markMessagesReadForMembership",
      "nowIso",
      "readInbox",
      "readInboxForMembership",
      "sendPlainMessage",
    ]);
    expectCompatibilityExports(legacyDelivery, [
      "DEFAULT_MESSAGE_POLL_MS",
      "DIRECT_MESSAGE_ACK_ENTRY_TYPE",
      "DIRECT_MESSAGE_CUSTOM_TYPE",
      "DIRECT_MESSAGE_RESUME_TYPE",
      "DirectMessageDelivery",
      "MESSAGE_POLL_MS_ENV",
      "acknowledgedMessageIdsFromEntries",
      "formatDirectMessageBatch",
      "messagePollMs",
      "observedMessageIdsFromContext",
      "pendingPresentedMessageIdsFromEntries",
    ]);
    expect(legacyAlerts.ALERT_KINDS).toBe(canonicalAlerts.ALERT_KINDS);
    expect(legacyAlerts.sendAlert).not.toBe(canonicalAlerts.sendAlert);
    expect(legacyInbox.sendPlainMessage).not.toBe(canonicalInbox.sendPlainMessage);
    expect(legacyDelivery.DirectMessageDelivery).not.toBe(canonicalDelivery.DirectMessageDelivery);
  });

  it("keeps inbox record schemas separate from Alert authority contracts", () => {
    const deliveryContracts = fs.readFileSync(path.join(root, "src/alert-authority/delivery-contracts.ts"), "utf8");
    const contracts = fs.readFileSync(path.join(root, "src/alert-authority/contracts.ts"), "utf8");
    expect(deliveryContracts).toMatch(/^export interface InboxMessage/m);
    expect(deliveryContracts).toMatch(/^export interface IdentifiedInboxMessage/m);
    expect(deliveryContracts).not.toMatch(/AlertKind|SendAlert|DirectMessage/);
    expect(contracts).toMatch(/^export const ALERT_KINDS/m);
    expect(contracts).toMatch(/^export interface SendAlertInput/m);
    expect(contracts).toMatch(/^export interface DirectMessageDeliverySink/m);
  });

  it("keeps durable Team and Coordination imports outside Alert authority", () => {
    const authorityFiles = [
      "alerts.ts",
      "inbox-delivery.ts",
      "direct-delivery.ts",
    ].map((file) => fs.readFileSync(path.join(root, "src/alert-authority", file), "utf8"));
    for (const source of authorityFiles) {
      expect(source).not.toMatch(/utils\/(teams|team-events)/);
    }
    const membershipAdapter = fs.readFileSync(path.join(root, "src/adapters/durable-alert-membership.ts"), "utf8");
    const publicationAdapter = fs.readFileSync(path.join(root, "src/adapters/durable-alert-publication.ts"), "utf8");
    expect(membershipAdapter).toContain("../utils/teams");
    expect(publicationAdapter).toContain("../coordination/event-journal");
    const contracts = fs.readFileSync(path.join(root, "src/alert-authority/contracts.ts"), "utf8");
    expect(contracts).toContain("currentRecipients");
    expect(contracts).toContain("withCurrentDelivery");
    expect(contracts).toContain("isCurrentSessionBinding");
    expect(contracts).not.toMatch(/AlertTeamConfig|readConfig|teamExists|withCurrentConfig/);
    for (const compatibilityFile of ["alerts.ts", "messaging.ts", "message-delivery.ts"]) {
      const source = fs.readFileSync(path.join(root, "src/utils", compatibilityFile), "utf8");
      expect(source).not.toMatch(/^const (membership|sender) =/m);
    }
  });

  it("keeps production consumers on canonical Alert authority paths", () => {
    const consumers = [
      ...productionFiles(path.join(root, "src")),
      ...productionFiles(path.join(root, "extensions")),
    ].filter((file) => !compatibilityPaths.has(file));
    const legacyImports = consumers.flatMap((file) => importSpecifiers(file)
      .filter((specifier) => /utils\/(alerts|messaging|message-delivery)$/.test(specifier))
      .map((specifier) => `${path.relative(root, file)} -> ${specifier}`));
    expect(legacyImports).toEqual([]);
  });

  it("keeps the e94664d package entry points and registered leader tools", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect({ main: manifest.main, exports: manifest.exports, files: manifest.files, pi: manifest.pi }).toEqual({
      main: "extensions/index.ts",
      exports: {
        ".": "./extensions/index.ts",
        "./observation": {
          types: "./dist/public/observation.d.ts",
          default: "./dist/public/observation.js",
        },
      },
      files: [
        "extensions", "skills", "src", "!src/**/*.test.ts", "!src/**/fixtures", "tsconfig.json",
        "package.json", "LICENSE", "README.md", "docs/current/README.md", "docs/reference.md", "dist",
      ],
      pi: {
        image: "https://raw.githubusercontent.com/deephbz/pi-team-bright/v0.17.0-rc.14/pi-team-in-action.png",
        extensions: ["extensions/index.ts"],
        skills: ["skills"],
      },
    });

    const registered: string[] = [];
    extension({
      registerTool(tool: { name: string }) { registered.push(tool.name); },
      on() {},
      sendMessage() {},
      appendEntry() {},
      sendUserMessage() {},
    } as any);
    expect(registered.sort()).toEqual([
      "alert_send", "ensure_worker", "task_create", "task_read", "task_update",
      "team_create", "team_shutdown", "team_sync", "worker_stop",
    ]);
  });
});
