import fs from "node:fs";
import path from "node:path";

export interface RegisteredTool {
  name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ): Promise<any>;
  renderResult?: (
    result: { content: any[]; details: unknown },
    options: { expanded: boolean; isPartial: boolean },
    theme: unknown,
    context: unknown,
  ) => { render(width: number): string[] };
}

export interface QaBrief {
  situation: string;
  agentNextDecision: string;
  humanQuestion: string;
  requiredAgentFacts: string[];
  machineEvidence: string[];
  agentNoiseCandidates: string[];
}

export interface QaCase {
  id: string;
  scenario: string;
  actor: string;
  call: {
    tool: string;
    arguments: Record<string, unknown>;
  };
  qaBrief: QaBrief;
  oracle: {
    before: unknown;
    after: unknown;
  };
  execution: {
    threw: boolean;
    isError: boolean;
  };
  projections: {
    agent: {
      content: any[];
      text: string;
      characters: number;
    };
    machine: {
      details: unknown;
      jsonCharacters: number;
    };
    human: {
      mode: "custom-renderer" | "agent-content-fallback";
      compact: string;
      expanded: string;
    };
  };
}

export interface QaBundle {
  schema: "pi-teams-tool-result-qa/1";
  generatedAt: string;
  source: {
    extension: "extensions/index.ts";
    scenarios: "scripts/tool-result-qa/suite.test.ts";
    rubric: "scripts/tool-result-qa/QA-PROMPT.md";
  };
  executionBoundary: {
    piProcessLaunched: false;
    modelInvoked: false;
    realTaskAuthority: "beads";
    terminal: "in-memory adapter";
  };
  fixtureTransitions: Array<{ action: string; evidence: unknown }>;
  cases: QaCase[];
  qaPrompt: string;
}

function contentText(content: any[]): string {
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function jsonSize(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

const identityTheme = new Proxy({}, {
  get: (_target, property) => {
    if (["fg", "bg"].includes(String(property))) return (_name: string, text: string) => text;
    if (["bold", "italic", "underline", "strikethrough"].includes(String(property))) return (text: string) => text;
    return undefined;
  },
});

function renderComponent(tool: RegisteredTool, result: any, args: Record<string, unknown>, expanded: boolean): string {
  if (!tool.renderResult) return contentText(result.content || []);
  try {
    const component = tool.renderResult(
      { content: result.content || [], details: result.details },
      { expanded, isPartial: false },
      identityTheme,
      {
        args,
        toolCallId: "qa-render",
        invalidate() {},
        lastComponent: undefined,
        state: {},
        cwd: process.cwd(),
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        expanded,
        showImages: false,
        isError: !!result.isError,
      },
    );
    return component.render(100).join("\n");
  } catch (error) {
    return `[QA renderer failed: ${error instanceof Error ? error.message : String(error)}]\n${contentText(result.content || [])}`;
  }
}

/**
 * Invoke one real registered tool definition and capture the three projections
 * a QA agent must review. Direct test invocation normalizes thrown errors the
 * same way pi-agent-core does: text reaches the agent/TUI and details is empty.
 */
export async function captureToolCase(options: {
  id: string;
  scenario: string;
  actor: string;
  tool: RegisteredTool;
  args: Record<string, unknown>;
  context: unknown;
  qaBrief: QaBrief;
  snapshot: () => Promise<unknown>;
}): Promise<QaCase> {
  const before = await options.snapshot();
  let threw = false;
  let result: any;
  try {
    result = await options.tool.execute(options.id, options.args, undefined, undefined, options.context);
    result = { ...result, isError: false };
  } catch (error) {
    threw = true;
    result = {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      details: {},
      isError: true,
    };
  }
  const after = await options.snapshot();
  const text = contentText(result.content || []);
  return {
    id: options.id,
    scenario: options.scenario,
    actor: options.actor,
    call: { tool: options.tool.name, arguments: options.args },
    qaBrief: options.qaBrief,
    oracle: { before, after },
    execution: { threw, isError: !!result.isError },
    projections: {
      agent: { content: result.content || [], text, characters: text.length },
      machine: { details: result.details, jsonCharacters: jsonSize(result.details) },
      human: {
        mode: options.tool.renderResult ? "custom-renderer" : "agent-content-fallback",
        compact: renderComponent(options.tool, result, options.args, false),
        expanded: renderComponent(options.tool, result, options.args, true),
      },
    },
  };
}

export function writeQaBundle(outputPath: string, bundle: QaBundle): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`);
}
