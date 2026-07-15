import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Member, ThinkingLevel } from "./models";

/**
 * Represents an agent definition from a .md file
 */
export interface AgentDefinition {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: ThinkingLevel;
  prompt: string;
  filePath: string;
}

/**
 * Represents a predefined team from teams.yaml
 */
export interface PredefinedTeam {
  name: string;
  agents: string[];
  description?: string;
}

/**
 * Project the append-ordered Membership history to the current teammate
 * roster. The latest record for a name is authoritative; an inactive latest
 * record therefore cannot accidentally resurrect an older active record.
 */
export function currentRuntimeTeammates(members: Member[]): Member[] {
  const latestByName = new Map<string, Member>();
  for (const member of members) latestByName.set(member.name, member);
  return [...latestByName.values()].filter(member =>
    member.agentType === "teammate" && member.isActive !== false
  );
}

/**
 * Parse frontmatter from a markdown file
 */
export function parseAgentFrontmatter(content: string, filePath: string): AgentDefinition | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    return null;
  }

  const frontmatterStr = frontmatterMatch[1];
  const prompt = frontmatterMatch[2].trim();
  const frontmatter: Record<string, string> = {};

  // Parse YAML-like frontmatter (simple key: value format)
  for (const line of frontmatterStr.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      frontmatter[key] = value;
    }
  }

  const name = frontmatter.name;
  if (!name) {
    return null;
  }

  const description = frontmatter.description || "";
  
  // Parse tools (comma-separated or space-separated)
  let tools: string[] | undefined;
  if (frontmatter.tools) {
    tools = frontmatter.tools.split(/[,\s]+/).map(t => t.trim()).filter(t => t);
  }

  const thinking = frontmatter.thinking as AgentDefinition["thinking"];
  const model = frontmatter.model;

  return {
    name,
    description,
    tools,
    model,
    thinking,
    prompt,
    filePath,
  };
}

/**
 * Discover agent definitions from a directory
 */
export function discoverAgents(dir: string): AgentDefinition[] {
  const agents: AgentDefinition[] = [];

  if (!fs.existsSync(dir)) {
    return agents;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isFile() && entry.name.endsWith(".md")) {
      const content = fs.readFileSync(fullPath, "utf-8");
      const agent = parseAgentFrontmatter(content, fullPath);
      if (agent) {
        agents.push(agent);
      }
    } else if (entry.isDirectory()) {
      // Check for SKILL.md style (agent-name/SKILL.md)
      const skillPath = path.join(fullPath, "SKILL.md");
      if (fs.existsSync(skillPath)) {
        const content = fs.readFileSync(skillPath, "utf-8");
        const agent = parseAgentFrontmatter(content, skillPath);
        if (agent) {
          agents.push(agent);
        }
      }
    }
  }

  return agents;
}

/**
 * Parse teams.yaml content into PredefinedTeam array
 */
export function parseTeamsYaml(content: string): PredefinedTeam[] {
  const teams: PredefinedTeam[] = [];
  const lines = content.split("\n");
  let currentTeam: PredefinedTeam | null = null;

  for (const line of lines) {
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith("#")) {
      continue;
    }

    // Check for team definition (no leading spaces, ends with colon)
    if (!line.startsWith(" ") && !line.startsWith("\t") && line.endsWith(":")) {
      // Save previous team
      if (currentTeam && currentTeam.agents.length > 0) {
        teams.push(currentTeam);
      }
      currentTeam = {
        name: line.slice(0, -1).trim(),
        agents: [],
      };
    } else if (currentTeam && (line.startsWith("  ") || line.startsWith("\t"))) {
      // Agent entry (indented line starting with -)
      const agentMatch = line.match(/^\s*-\s*(.+)$/);
      if (agentMatch) {
        currentTeam.agents.push(agentMatch[1].trim());
      }
    }
  }

  // Save last team
  if (currentTeam && currentTeam.agents.length > 0) {
    teams.push(currentTeam);
  }

  return teams;
}

/**
 * Discover predefined teams from teams.yaml files
 */
export function discoverTeams(dir: string): PredefinedTeam[] {
  const teamsPath = path.join(dir, "teams.yaml");
  
  if (!fs.existsSync(teamsPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(teamsPath, "utf-8");
    return parseTeamsYaml(content);
  } catch {
    return [];
  }
}

/**
 * Get all agent definitions from all locations
 * Priority: project-local > global
 */
export function getAllAgentDefinitions(projectDir?: string): AgentDefinition[] {
  const agents: AgentDefinition[] = [];
  const seenNames = new Set<string>();

  // Global agent definitions
  const globalDir = path.join(os.homedir(), ".pi", "agent", "agents");
  for (const agent of discoverAgents(globalDir)) {
    if (!seenNames.has(agent.name)) {
      seenNames.add(agent.name);
      agents.push(agent);
    }
  }

  // Project-local agent definitions
  if (projectDir) {
    const projectAgentsDir = path.join(projectDir, ".pi", "agents");
    for (const agent of discoverAgents(projectAgentsDir)) {
      if (!seenNames.has(agent.name)) {
        seenNames.add(agent.name);
        agents.push(agent);
      } else {
        // Override global with project-local
        const idx = agents.findIndex(a => a.name === agent.name);
        if (idx >= 0) {
          agents[idx] = agent;
        }
      }
    }
  }

  return agents;
}

/**
 * Get all predefined teams from all locations
 * Priority: project-local > global
 */
export function getAllPredefinedTeams(projectDir?: string): PredefinedTeam[] {
  const teams: PredefinedTeam[] = [];
  const seenNames = new Set<string>();

  // Global teams: prefer the documented ~/.pi/teams.yaml location,
  // but still fall back to the legacy ~/.pi/agent/teams.yaml path.
  const globalDirs = [
    path.join(os.homedir(), ".pi"),
    path.join(os.homedir(), ".pi", "agent"),
  ];
  for (const globalDir of globalDirs) {
    for (const team of discoverTeams(globalDir)) {
      if (!seenNames.has(team.name)) {
        seenNames.add(team.name);
        teams.push(team);
      }
    }
  }

  // Project-local teams
  if (projectDir) {
    const projectDirPath = path.join(projectDir, ".pi");
    for (const team of discoverTeams(projectDirPath)) {
      if (!seenNames.has(team.name)) {
        seenNames.add(team.name);
        teams.push(team);
      } else {
        // Override global with project-local
        const idx = teams.findIndex(t => t.name === team.name);
        if (idx >= 0) {
          teams[idx] = team;
        }
      }
    }
  }

  return teams;
}

/**
 * Get a specific agent definition by name
 */
export function getAgentDefinition(name: string, projectDir?: string): AgentDefinition | undefined {
  const agents = getAllAgentDefinitions(projectDir);
  return agents.find(a => a.name === name);
}

/**
 * Get a specific predefined team by name
 */
export function getPredefinedTeam(name: string, projectDir?: string): PredefinedTeam | undefined {
  const teams = getAllPredefinedTeams(projectDir);
  return teams.find(t => t.name === name);
}

/**
 * Options for saving a team as a template
 */
export interface SaveTeamTemplateOptions {
  templateName: string;
  description?: string;
  scope: "user" | "project";
  projectDir?: string;
  dryRun?: boolean;
}

/**
 * Result of saving a team as a template
 */
export interface SaveTeamTemplateResult {
  templateName: string;
  agentsDir: string;
  teamsYamlPath: string;
  savedAgents: Array<{
    name: string;
    path: string;
    existed: boolean;
  }>;
  templateExisted: boolean;
  dryRun: boolean;
  artifacts: Array<{
    kind: "agent_definition" | "team_manifest";
    path: string;
    action: "create" | "update";
    content: string;
    written: boolean;
  }>;
}

/**
 * Generate markdown content for an agent definition file
 */
export function generateAgentMarkdown(agent: {
  name: string;
  description?: string;
  tools?: string[];
  model?: string;
  thinking?: ThinkingLevel;
  prompt?: string;
}): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${agent.name}`);
  if (agent.description) {
    lines.push(`description: ${agent.description}`);
  }
  if (agent.tools && agent.tools.length > 0) {
    lines.push(`tools: ${agent.tools.join(", ")}`);
  }
  if (agent.model) {
    lines.push(`model: ${agent.model}`);
  }
  if (agent.thinking) {
    lines.push(`thinking: ${agent.thinking}`);
  }
  lines.push("---");
  lines.push("");
  if (agent.prompt) {
    lines.push(agent.prompt);
  }
  return lines.join("\n");
}

/**
 * Generate teams.yaml content by adding a new team template
 */
export function generateTeamsYamlWithTemplate(
  existingContent: string,
  templateName: string,
  agentNames: string[],
  description?: string
): string {
  // Check if template already exists
  const lines = existingContent.split("\n");
  let templateExists = false;
  let templateStartLine = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === `${templateName}:`) {
      templateExists = true;
      templateStartLine = i;
      break;
    }
  }

  if (templateExists) {
    // Replace existing template - find where it ends
    let templateEndLine = templateStartLine + 1;
    while (templateEndLine < lines.length && (lines[templateEndLine].startsWith("  ") || lines[templateEndLine].startsWith("\t"))) {
      templateEndLine++;
    }
    // Remove old template lines
    lines.splice(templateStartLine, templateEndLine - templateStartLine);
  }

  // Build new template entry
  const templateLines: string[] = [];
  if (description) {
    templateLines.push(`# ${description}`);
  }
  templateLines.push(`${templateName}:`);
  for (const agentName of agentNames) {
    templateLines.push(`  - ${agentName}`);
  }
  templateLines.push("");

  // Find insertion point (at the end or after existing content)
  let insertIndex = lines.length;
  
  // Remove trailing empty lines to find actual end
  while (insertIndex > 0 && lines[insertIndex - 1].trim() === "") {
    insertIndex--;
  }

  // Insert new template
  lines.splice(insertIndex, 0, ...templateLines);

  return lines.join("\n");
}

/**
 * Save a team configuration as a reusable template.
 * Creates agent definition files and updates teams.yaml.
 */
export function saveTeamTemplate(
  teamConfig: {
    name: string;
    description?: string;
    members: Array<{
      name: string;
      agentType: string;
      model?: string;
      thinking?: ThinkingLevel;
      prompt?: string;
    }>;
    defaultModel?: string;
  },
  options: SaveTeamTemplateOptions
): SaveTeamTemplateResult {
  // Determine output paths based on scope
  const agentsDir = options.scope === "project"
    ? path.join(options.projectDir || process.cwd(), ".pi", "agents")
    : path.join(os.homedir(), ".pi", "agent", "agents");

  const teamsYamlPath = options.scope === "project"
    ? path.join(options.projectDir || process.cwd(), ".pi", "teams.yaml")
    : path.join(os.homedir(), ".pi", "teams.yaml");

  const dryRun = options.dryRun ?? false;

  // Create parent storage only for an actual write. Dry-run is side-effect free.
  if (!dryRun && !fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true });
  }

  // Export only the current roster. Historical Membership records remain in
  // TeamConfig for audit/recovery but are not reusable template members.
  const teammates = currentRuntimeTeammates(teamConfig.members as Member[]);
  const agentNames: string[] = [];
  const savedAgents: SaveTeamTemplateResult["savedAgents"] = [];
  const artifacts: SaveTeamTemplateResult["artifacts"] = [];

  // Save each teammate as an agent definition
  for (const member of teammates) {
    const agentFileName = `${member.name}.md`;
    const agentPath = path.join(agentsDir, agentFileName);
    const existed = fs.existsSync(agentPath);

    // Use the model from the member, or fall back to the team's default model
    const model = member.model || teamConfig.defaultModel;

    const content = generateAgentMarkdown({
      name: member.name,
      description: `Agent from team '${teamConfig.name}'`,
      model,
      thinking: member.thinking,
      prompt: member.prompt,
    });

    if (!dryRun) fs.writeFileSync(agentPath, content);
    agentNames.push(member.name);
    savedAgents.push({ name: member.name, path: agentPath, existed });
    artifacts.push({
      kind: "agent_definition",
      path: agentPath,
      action: existed ? "update" : "create",
      content,
      written: !dryRun,
    });
  }

  // Update teams.yaml
  let teamsContent = "";
  const teamsYamlExisted = fs.existsSync(teamsYamlPath);
  if (teamsYamlExisted) {
    teamsContent = fs.readFileSync(teamsYamlPath, "utf-8");
  }

  // Check if template already exists
  const templateExisted = teamsContent.includes(`${options.templateName}:`);

  // Generate updated teams.yaml content
  const updatedContent = generateTeamsYamlWithTemplate(
    teamsContent,
    options.templateName,
    agentNames,
    options.description || teamConfig.description
  );

  if (!dryRun) {
    fs.mkdirSync(path.dirname(teamsYamlPath), { recursive: true });
    fs.writeFileSync(teamsYamlPath, updatedContent);
  }
  artifacts.push({
    kind: "team_manifest",
    path: teamsYamlPath,
    action: teamsYamlExisted ? "update" : "create",
    content: updatedContent,
    written: !dryRun,
  });

  return {
    templateName: options.templateName,
    agentsDir,
    teamsYamlPath,
    savedAgents,
    templateExisted,
    dryRun,
    artifacts,
  };
}
