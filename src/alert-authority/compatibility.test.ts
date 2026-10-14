import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import extension from "../../extensions/index";
const root = process.cwd();

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

describe("Alert canonical authority compatibility", () => {
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
  });

  it("keeps production consumers on canonical Alert authority paths", () => {
    const consumers = [
      ...productionFiles(path.join(root, "src")),
      ...productionFiles(path.join(root, "extensions")),
    ];
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
        "native", "!native/bin", "scripts/build-process-generation.sh",
        "extensions", "!extensions/**/*.test.ts", "skills", "src", "!src/**/*.test.ts", "!src/**/fixtures", "tsconfig.json",
        "package.json", "LICENSE", "README.md", "docs/current/README.md", "docs/reference.md",
        "docs/examples/pi-team-bright.settings.json", "dist",
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
      "alert_send", "ensure_worker", "task_graph_apply", "task_read", "task_update",
      "team_create", "team_shutdown", "team_sync", "worker_stop",
    ]);
  });
});
