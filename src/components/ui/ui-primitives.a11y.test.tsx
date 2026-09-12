/**
 * Accessibility (a11y) regression net for the shared `ui/` primitives and two
 * key composed dialogs (audit finding TFE-012).
 *
 * These are the building blocks every dialog and form in the app composes from,
 * so guarding their roles/labels/`aria-*` here catches an accessibility
 * regression at the source — before it propagates to ~94 call sites. Each test
 * renders the component and asserts `axe-core` finds zero violations; see
 * `src/test/axe.ts` for the shared helper and the pattern for adding more.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { checkA11y } from "@/test/axe";
import { Button } from "./Button";
import { Field } from "./Field";
import { Input } from "./Input";
import { NumberInput } from "./NumberInput";
import { Toggle } from "./Toggle";
import { Checkbox } from "./Checkbox";
import { RadioGroup } from "./RadioGroup";
import { Select } from "./Select";
import { Progress } from "./Progress";
import { EmptyState } from "./EmptyState";
import { Modal } from "./Modal";
import { ConfirmDialog } from "./ConfirmDialog";
import { TrustPrompt, type TrustFact } from "./TrustPrompt";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => root.render(ui));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ui primitives — accessibility (TFE-012)", () => {
  it("Button has no a11y violations", async () => {
    render(<Button>Save</Button>);
    expect(await checkA11y()).toHaveNoViolations();
  });

  it("Field + Input (labelled control) has no a11y violations", async () => {
    render(
      <Field label="Host" htmlFor="host">
        <Input id="host" />
      </Field>
    );
    expect(await checkA11y()).toHaveNoViolations();
  });

  it("Field + NumberInput with an inline error has no a11y violations", async () => {
    render(
      <Field label="Port" htmlFor="port" error="Port is required">
        <NumberInput id="port" value="" onValueChange={() => {}} />
      </Field>
    );
    expect(await checkA11y()).toHaveNoViolations();
  });

  it("Toggle (aria-labelled switch) has no a11y violations", async () => {
    render(<Toggle checked={false} onCheckedChange={() => {}} aria-label="Wrap lines" />);
    expect(await checkA11y()).toHaveNoViolations();
  });

  it("Checkbox (aria-labelled) has no a11y violations", async () => {
    render(<Checkbox checked={false} onCheckedChange={() => {}} aria-label="Remember me" />);
    expect(await checkA11y()).toHaveNoViolations();
  });

  it("RadioGroup (labelled group) has no a11y violations", async () => {
    render(
      <RadioGroup
        value="a"
        onValueChange={() => {}}
        aria-label="Authentication method"
        options={[
          { value: "a", label: "Password" },
          { value: "b", label: "Public key" },
        ]}
      />
    );
    expect(await checkA11y()).toHaveNoViolations();
  });

  it("Select (labelled trigger) has no a11y violations", async () => {
    render(
      <Select
        value="a"
        onChange={() => {}}
        aria-label="Shell"
        options={[
          { value: "a", label: "bash" },
          { value: "b", label: "zsh" },
        ]}
      />
    );
    expect(await checkA11y()).toHaveNoViolations();
  });

  it("Progress (labelled progressbar) has no a11y violations", async () => {
    render(<Progress value={40} label="Uploading" />);
    expect(await checkA11y()).toHaveNoViolations();
  });

  it("EmptyState has no a11y violations", async () => {
    render(<EmptyState title="No connections yet" description="Add one to get started" />);
    expect(await checkA11y()).toHaveNoViolations();
  });

  it("Modal (named dialog) has no a11y violations", async () => {
    render(
      <Modal open onOpenChange={() => {}} title="Settings" description="Application settings">
        <p>Body content</p>
      </Modal>
    );
    expect(await checkA11y()).toHaveNoViolations();
  });

  it("ConfirmDialog has no a11y violations", async () => {
    render(
      <ConfirmDialog
        open
        title="Delete connection?"
        message="This cannot be undone."
        description="Confirm deleting the connection"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(await checkA11y()).toHaveNoViolations();
  });

  it("TrustPrompt (changed identity, MITM warning) has no a11y violations", async () => {
    const facts: TrustFact[] = [
      { label: "Host", value: "server.example:2222", testId: "tp-host" },
      { label: "Fingerprint", value: "SHA256:abc123", mono: true, copyable: true, testId: "tp-fp" },
    ];
    render(
      <TrustPrompt
        open
        changed
        unknownTitle="Unknown host key"
        changedTitle="Host key changed"
        unknownLead="This server presented a host key:"
        changedLead="This server's host key changed:"
        changedWarningSubject="host key for this server"
        facts={facts}
        onReject={() => {}}
        onAcceptOnce={() => {}}
        onAcceptForHost={() => {}}
        modalTestId="tp"
        rejectTestId="tp-reject"
        acceptOnceTestId="tp-once"
        acceptForHostTestId="tp-host-btn"
        warningTestId="tp-warn"
      />
    );
    expect(await checkA11y()).toHaveNoViolations();
  });
});
