import type { DockerContainerInfo } from "@/services/api";
import { compareNames } from "@/utils/locale";

/**
 * Natural, locale-aware name order via the shared collator (#4374), with an
 * exact code-unit tie-break so names differing only in case/accents still sort
 * deterministically.
 */
function byName(a: string, b: string): number {
  return compareNames(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

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
    .sort(([a], [b]) => byName(a, b))
    .map(([project, list]) => ({ project, containers: list }));
  if (plain.length > 0 || groups.length === 0) {
    groups.push({ project: null, containers: plain });
  }
  return groups;
}

/** One Docker Compose service offered by the picker's service mode (#3784). */
export interface DockerComposeService {
  /** Compose project name. */
  project: string;
  /** Compose service name. */
  service: string;
  /** The stored connection value: `project/service`. */
  value: string;
  /** Containers (replicas) of the service, running or not. */
  replicas: number;
  /** How many of those replicas are running. */
  running: number;
}

/** A Compose project and its services, for the picker's service mode (#3784). */
export interface DockerComposeServiceGroup {
  project: string;
  services: DockerComposeService[];
}

/**
 * Collapse the listed containers into their Docker Compose services (#3784).
 *
 * Each `(project, service)` pair appears once, with its replica and running
 * counts. Containers missing either label are not part of a service and are
 * skipped. Projects and services are sorted case-insensitively.
 */
export function composeServicesFromContainers(
  containers: DockerContainerInfo[]
): DockerComposeServiceGroup[] {
  const projects = new Map<string, Map<string, DockerComposeService>>();
  for (const c of containers) {
    const project = c.composeProject?.trim();
    const service = c.composeService?.trim();
    if (!project || !service) continue;
    let services = projects.get(project);
    if (!services) {
      services = new Map();
      projects.set(project, services);
    }
    let entry = services.get(service);
    if (!entry) {
      entry = { project, service, value: `${project}/${service}`, replicas: 0, running: 0 };
      services.set(service, entry);
    }
    entry.replicas += 1;
    if (c.running) entry.running += 1;
  }
  return [...projects.entries()]
    .sort(([a], [b]) => byName(a, b))
    .map(([project, services]) => ({
      project,
      services: [...services.values()].sort((a, b) => byName(a.service, b.service)),
    }));
}
