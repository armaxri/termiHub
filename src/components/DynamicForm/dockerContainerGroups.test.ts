import { describe, it, expect } from "vitest";
import type { DockerContainerInfo } from "@/services/api";
import { groupContainersByComposeProject } from "./dockerContainerGroups";

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
