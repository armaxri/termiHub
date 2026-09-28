import type { DockerContainerInfo } from "@/services/api";

/** One section of the Docker container picker (#3425). */
export interface DockerContainerGroup {
  /** Compose project name, or `null` for containers not started by Compose. */
  project: string | null;
  /** The group's containers, in the order the backend listed them. */
  containers: DockerContainerInfo[];
}

/**
 * Group picker containers by their Docker Compose project (#3425).
 *
 * Compose projects come first, sorted case-insensitively; containers without a
 * project follow in one trailing `project: null` group. Within a group the
 * backend's order (running first, then by name) is kept. When no container
 * belongs to a Compose project the result is a single `null` group, so the
 * picker can render a flat list exactly as before.
 */
export function groupContainersByComposeProject(
  containers: DockerContainerInfo[]
): DockerContainerGroup[] {
  const byProject = new Map<string, DockerContainerInfo[]>();
  const plain: DockerContainerInfo[] = [];
  for (const c of containers) {
    const project = c.composeProject?.trim();
    if (project) {
      const group = byProject.get(project);
      if (group) group.push(c);
      else byProject.set(project, [c]);
    } else {
      plain.push(c);
    }
  }
  const groups: DockerContainerGroup[] = [...byProject.entries()]
    .sort(([a], [b]) => {
      const byLower = a.toLowerCase().localeCompare(b.toLowerCase());
      return byLower !== 0 ? byLower : a.localeCompare(b);
    })
    .map(([project, list]) => ({ project, containers: list }));
  if (plain.length > 0 || groups.length === 0) {
    groups.push({ project: null, containers: plain });
  }
  return groups;
}
