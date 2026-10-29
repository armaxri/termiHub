import { Field, Select } from "@/components/ui";
import type { HostOrder } from "./useHostOrder";

const ORDER_OPTIONS = [
  { value: "address", label: "Address" },
  { value: "response", label: "Response order" },
];

interface HostOrderFieldProps {
  /** Unique id for the trigger (label target). */
  id: string;
  order: HostOrder;
  onChange: (order: HostOrder) => void;
  "data-testid"?: string;
}

/**
 * "Order" control for Network Tools host lists (#5067): numeric address order
 * or the order hosts responded in. Sits in the panel's form row next to the
 * other inputs, like the Open Ports protocol filter.
 */
export function HostOrderField({
  id,
  order,
  onChange,
  "data-testid": testId,
}: HostOrderFieldProps) {
  return (
    <Field className="network-panel__field network-panel__field--small" label="Order" htmlFor={id}>
      <Select
        id={id}
        value={order}
        onChange={(value) => onChange(value === "response" ? "response" : "address")}
        options={ORDER_OPTIONS}
        aria-label="Result order"
        data-testid={testId}
      />
    </Field>
  );
}
