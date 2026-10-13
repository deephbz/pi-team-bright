import type { ExecResult } from "../env/host-env";

export type HerdrEnvelope = {
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
};

/** Only a structured Herdr error proves a refusal such as pane_not_found. */
export class HerdrRequestError extends Error {
  readonly code: string;
  readonly fact: string;

  constructor(error: NonNullable<HerdrEnvelope["error"]>) {
    const code = typeof error.code === "string" ? error.code : "unknown_error";
    const message = typeof error.message === "string" ? error.message : "Herdr returned an invalid error response";
    const fact = `${code}: ${message}`;
    super(`Herdr request failed: ${fact}`);
    this.name = "HerdrRequestError";
    this.code = code;
    this.fact = fact;
  }
}

/** Herdr sends errors on stderr. Nonempty stdout remains authoritative. */
export function readHerdrEnvelope(response: Pick<ExecResult, "stdout" | "stderr">): HerdrEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.stdout.trim() ? response.stdout : response.stderr);
  } catch {
    throw new Error("Herdr returned malformed JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Herdr returned an invalid JSON envelope.");
  }
  return parsed as HerdrEnvelope;
}

export function herdrResult(envelope: HerdrEnvelope): Record<string, unknown> {
  if (envelope.error) throw new HerdrRequestError(envelope.error);
  const result = envelope.result ?? envelope;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Herdr returned a response without an object result.");
  }
  return result as Record<string, unknown>;
}

export function readHerdrReply(response: ExecResult): Record<string, unknown> {
  const result = herdrResult(readHerdrEnvelope(response));
  if (response.status !== 0) {
    throw new Error(`Herdr command failed with status ${response.status}: ${response.stderr || "unknown error"}`);
  }
  return result;
}
