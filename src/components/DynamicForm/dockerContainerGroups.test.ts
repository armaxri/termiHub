import { describe, it, expect } from "vitest";
import type { DockerContainerInfo } from "@/services/api";
import {
  composeServicesFromContainers,
  groupContainersByComposeProject,
} from "./dockerContainerGroups";

function c(name: string, project?: string, service?: string): DockerContainerInfo {
  return {
    id: `${name}-id`,
    name,
    image: "img",
    state: "running",
    status: "Up",
    running: true,
    ...(project !== undefined ? { composeProject: project } : {}),
    ...(service !== undefined ? { composeService: service } : {}),
  };
}

const names = (groups: ReturnType<typeof groupContainersByComposeProject>) =>
  groups.map((g) => [g.project, g.containers.map((x) => x.name)]);

describe("groupContainersByComposeProject (#3425)", () => {
  it("returns one plain group for an empty list", () => {
    expect(names(groupContainersByComposeProject([]))).toEqual([[null, []]]);
  });

  it("returns one plain group when nothing is from compose", () => {
    expect(names(groupContainersByComposeProject([c("a"), c("b")]))).toEqual([[null, ["a", "b"]]]);
  });

  it("groups mixed containers: projects sorted case-insensitively, plain last, order kept", () => {
    const groups = groupContainersByComposeProject([
      c("shop-web", "shop", "web"),
      c("plain"),
      c("Blog-db", "Blog", "db"),
      c("shop-db", "shop", "db"),
      c("alpha-x", "alpha"),
    ]);
    expect(names(groups)).toEqual([
      ["alpha", ["alpha-x"]],
      ["Blog", ["Blog-db"]],
      ["shop", ["shop-web", "shop-db"]],
      [null, ["plain"]],
    ]);
  });

  it("omits the plain group when every container is from compose", () => {
    expect(names(groupContainersByComposeProject([c("x", "p")]))).toEqual([["p", ["x"]]]);
  });

  it("treats a blank project as plain", () => {
    expect(names(groupContainersByComposeProject([c("x", "  ")]))).toEqual([[null, ["x"]]]);
  });
});

describe("composeServicesFromContainers (#3784)", () => {
  const stopped = (x: DockerContainerInfo): DockerContainerInfo => ({
    ...x,
    running: false,
    state: "exited",
  });

  it("returns no groups without compose containers", () => {
    expect(composeServicesFromContainers([c("a"), c("b", "shop")])).toEqual([]);
  });

  it("collapses replicas into one service with counts", () => {
    const groups = composeServicesFromContainers([
      c("shop-web-1", "shop", "web"),
      stopped(c("shop-web-2", "shop", "web")),
      c("shop-db-1", "shop", "db"),
      c("Blog-app-1", "Blog", "app"),
      c("plain"),
    ]);
    expect(groups.map((g) => g.project)).toEqual(["Blog", "shop"]);
    expect(groups[1].services).toEqual([
      { project: "shop", service: "db", value: "shop/db", replicas: 1, running: 1 },
      { project: "shop", service: "web", value: "shop/web", replicas: 2, running: 1 },
    ]);
    expect(groups[0].services.map((s) => s.value)).toEqual(["Blog/app"]);
  });
});
