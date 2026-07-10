import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentVersionBadge } from "./AgentVersionBadge";

describe("AgentVersionBadge", () => {
  it("renders the version chip prefixed with v", () => {
    render(<AgentVersionBadge version="0.1.0" state="up-to-date" />);
    expect(screen.getByText("v0.1.0")).toBeInTheDocument();
  });

  it("applies the state modifier class for each state", () => {
    const { rerender, container } = render(
      <AgentVersionBadge version="0.1.0" state="up-to-date" />
    );
    expect(container.querySelector(".agent-version-badge__state--up-to-date")).toBeTruthy();

    rerender(<AgentVersionBadge version="0.1.0" state="update-available" />);
    expect(container.querySelector(".agent-version-badge__state--update-available")).toBeTruthy();

    rerender(<AgentVersionBadge version="1.0.0" state="incompatible" />);
    expect(container.querySelector(".agent-version-badge__state--incompatible")).toBeTruthy();

    rerender(<AgentVersionBadge version="0.1.0" state="updating" />);
    expect(container.querySelector(".agent-version-badge__state--updating")).toBeTruthy();
  });

  it("exposes an accessible label describing the update state", () => {
    render(<AgentVersionBadge version="0.1.0" state="update-available" />);
    expect(screen.getByLabelText(/update available/i)).toBeInTheDocument();
  });

  it("renders a text label when showLabel is set", () => {
    render(<AgentVersionBadge version="0.1.0" state="update-available" showLabel />);
    expect(screen.getByText(/update available/i)).toBeInTheDocument();
  });

  it("renders nothing when the state is unknown", () => {
    const { container } = render(<AgentVersionBadge version="" state="unknown" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when no version is supplied", () => {
    const { container } = render(<AgentVersionBadge state="up-to-date" />);
    expect(container.firstChild).toBeNull();
  });

  it("forwards a data-testid to the root", () => {
    render(
      <AgentVersionBadge version="0.1.0" state="up-to-date" data-testid="agent-version-badge-x" />
    );
    expect(screen.getByTestId("agent-version-badge-x")).toBeInTheDocument();
  });
});
