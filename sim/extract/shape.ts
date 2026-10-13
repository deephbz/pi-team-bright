import { modelToolCatalog, GraphTaskUpdateParametersSchema } from "../../src/model-tool-contract/catalog";

// Schemas own public keys and discriminators. Unknown dictionary keys are identities.
const publicKeys = new Set(("task_version pid processId process_id id team team_name worker_name agent assignee from actor session session_id sessionFile task taskId ref dependencies changes nodes edges relations prompt context evidence reason version cursor after_cursor model thinking cwd path timeout timeout_ms limit count force cascade mode target source failure_route retry max_attempts on_failure repair cancel resume shutdown metadata message content expected_status status action subscription subscriptions description model_profile modelProfile").split(" "));
const literals = new Map<string, Set<string>>();
function collect(schema: any, key = ""): void {
  if (!schema || typeof schema !== "object") return;
  const values = [...(Array.isArray(schema.enum) ? schema.enum : []), ...(typeof schema.const === "string" ? [schema.const] : [])];
  for (const value of values) if (typeof value === "string") {
    const set = literals.get(key) ?? new Set<string>(); set.add(value); literals.set(key, set);
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) { publicKeys.add(name); collect(child, name); }
  if (schema.items) collect(schema.items, key);
  for (const branch of ["anyOf", "oneOf", "allOf"]) for (const child of schema[branch] ?? []) collect(child, key);
}
for (const schema of [...modelToolCatalog.tools.map(t => t.parameters), GraphTaskUpdateParametersSchema]) collect(schema);
for (const [key, values] of Object.entries({ thinking: ["off", "minimal", "low", "medium", "high", "xhigh"], status: ["open", "closed", "ready", "in_progress", "blocked", "done", "failed", "cancelled"], action: ["claim", "close", "update", "link", "unlink"], mode: ["snapshot", "updates"] })) {
  const set = literals.get(key) ?? new Set<string>(); for (const value of values) set.add(value); literals.set(key, set);
}

/** Injective, per-trace synthetic values. Source lengths and public value grammars survive. */
export class ShapeRedactor {
  private readonly strings = new Map<string, string>();
  private readonly used = new Set<string>();
  private serial = 0;
  private readonly numbers = new Map<number, number>();
  ref(raw: unknown, _prefix = "ref"): string {
    const value = typeof raw === "string" ? raw : JSON.stringify(raw) ?? "missing";
    const old = this.strings.get(value);
    if (old !== undefined) return old;
    if (value === "") return "";
    let token: string;
    do {
      const n = ++this.serial;
      if (/^[vg]_[0-9a-f]{16}$/.test(value)) token = value.slice(0, 2) + n.toString(16).padStart(16, "0");
      else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
        const hex = n.toString(16).padStart(32, "0"); token = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      } else if (value.length === 1) {
        // Short values cannot carry a prefix. The finite alphabet stays valid for name keys.
        const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
        if (this.used.size > 100000) throw new Error("Synthetic value space exhausted");
        token = alphabet[n % alphabet.length];
        if ([...alphabet].every(c => this.used.has(c) || c === value)) throw new Error("Synthetic single-character value space exhausted");
      } else token = ("z".repeat(value.length) + n.toString(36)).slice(-value.length);
    } while (token === value || this.used.has(token));
    this.strings.set(value, token); this.used.add(token); return token;
  }
  args(value: unknown, key = "", depth = 0): any {
    if (depth > 100) throw new Error("Argument nesting exceeds extraction bound");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      // Counts, ordinals and limits retain their semantics. Process identifiers do not.
      if (/^(pid|processId|process_id)$/i.test(key)) {
        const old = this.numbers.get(value);
        if (old !== undefined) return old;
        const width = String(Math.abs(value)).length;
        let n = 10 ** (width - 1);
        while (n === value || [...this.numbers.values()].includes(n)) n++;
        if (String(n).length !== width) throw new Error("Synthetic numeric identity space exhausted");
        this.numbers.set(value, n); return n;
      }
      return value;
    }
    if (typeof value === "string") {
      if (literals.get(key)?.has(value)) return value;
      if (["to", "from", "assignee", "worker"].includes(key) && value === "team-lead") return value;
      return this.ref(value);
    }
    if (Array.isArray(value)) return value.map(v => this.args(v, key, depth + 1));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [publicKeys.has(k) ? k : this.ref(k), this.args(v, k, depth + 1)]));
    throw new Error("Non-JSON argument value");
  }
}
