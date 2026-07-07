import React from "react";
import { TooltipProvider } from "@/components/ui/Tooltip";

/**
 * Wrap a subtree in a zero-delay {@link TooltipProvider} so the shared Tooltip
 * primitive finds its provider and reveals content synchronously in tests.
 *
 * This replaces the byte-identical `withTooltip` helper that was previously
 * redefined in every tooltip-touching component test.
 *
 * @param ui - The React element(s) to wrap.
 * @returns The element wrapped in a zero-delay tooltip provider.
 */
export function withTooltip(ui: React.ReactElement): React.ReactElement {
  return <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>;
}
