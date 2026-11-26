import { useEffect, useState } from "react";
import { Field, Input, RadioGroup, Select } from "@/components/ui";
import { t } from "@/i18n/catalog";
import { listNetworkInterfaces } from "@/services/embeddedServerApi";
import type { NetworkInterface } from "@/types/embeddedServer";
import { errorMessage } from "@/utils/errorMessage";
import { frontendWarn } from "@/utils/frontendLog";
import { ownAddresses, whoOf, type Who } from "./bindWho";

interface WhoCanOpenProps {
  /** Prefix of the test ids and of the field's ids. */
  testId: string;
  id: string;
  /** The bind address; empty while nobody was chosen. */
  bind: string;
  onBind: (bind: string) => void;
  labels: Record<Who, string>;
  /** What "here" is stored as. */
  here: string;
  /** Whether this computer opens it: else its addresses are not known, but typed. */
  onThisComputer: boolean;
  error?: string;
}

/**
 * Who can open a port (#6028, #6063): the machine that opens it, everyone who reaches
 * that machine, or whoever reaches one of its addresses.
 */
export function WhoCanOpen({
  testId,
  id,
  bind,
  onBind,
  labels,
  here,
  onThisComputer,
  error,
}: WhoCanOpenProps) {
  const [interfaces, setInterfaces] = useState<NetworkInterface[]>([]);
  useEffect(() => {
    if (!onThisComputer) return;
    let current = true;
    listNetworkInterfaces()
      .then((found) => current && setInterfaces(found))
      // The other choices work without it.
      .catch((err: unknown) =>
        frontendWarn("services", `listing network interfaces failed: ${errorMessage(err)}`)
      );
    return () => {
      current = false;
    };
  }, [onThisComputer]);

  // One address is chosen before it is known which.
  const [wantsAddress, setWantsAddress] = useState(false);
  const who = wantsAddress ? "address" : whoOf(bind);
  const addresses = onThisComputer ? ownAddresses(interfaces, bind) : [];
  const choose = (next: Who) => {
    setWantsAddress(next === "address");
    if (next === "here") onBind(here);
    else if (next === "network") onBind("0.0.0.0");
    else onBind(addresses[0]?.value ?? "");
  };
  const options = (["here", "network", "address"] as const)
    .filter((value) => value !== "address" || !onThisComputer || addresses.length > 0)
    .map((value) => ({
      value,
      label: labels[value],
      "data-testid": `${testId}-bind-${value}`,
    }));

  return (
    <>
      <Field
        label={t("server.editor.who")}
        error={who === "address" ? undefined : error}
        data-testid={`${testId}-bind`}
      >
        <RadioGroup
          value={who ?? ""}
          onValueChange={(next) => choose(next as Who)}
          aria-label={t("server.editor.who")}
          options={options}
          data-testid={`${testId}-bind-host`}
        />
      </Field>
      {who === "address" && (
        <Field
          className="service-editor__indent"
          label={t("server.editor.who.address")}
          htmlFor={`${id}-address`}
          error={error}
        >
          {onThisComputer ? (
            <Select
              id={`${id}-address`}
              value={bind}
              onChange={onBind}
              options={addresses}
              aria-label={t("server.editor.who.address")}
              data-testid={`${testId}-address`}
            />
          ) : (
            <Input
              id={`${id}-address`}
              value={bind}
              onChange={(e) => onBind(e.target.value)}
              placeholder={t("server.editor.who.address.placeholder")}
              error={Boolean(error)}
              data-testid={`${testId}-address`}
            />
          )}
        </Field>
      )}
    </>
  );
}
