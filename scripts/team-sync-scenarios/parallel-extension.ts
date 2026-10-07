// Test only: retain the production tool and hooks, but expose Pi's parallel scheduler.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import teamBright from "../../extensions/index";

export default function parallelExtension(pi: ExtensionAPI) {
  return teamBright(new Proxy(pi, {
    get(target, key) {
      if (key === "registerTool") return (definition: any) => target.registerTool(
        definition.name === "team_sync" ? { ...definition, executionMode: "parallel" } : definition,
      );
      return Reflect.get(target, key);
    },
  }));
}
