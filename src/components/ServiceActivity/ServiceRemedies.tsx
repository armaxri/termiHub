import { Activity } from "lucide-react";
import { useEditorViews } from "@/components/ServiceEditor/editorView";
import { Button } from "@/components/ui";
import { useServiceNextStep } from "@/hooks/useServiceNextStep";
import { t } from "@/i18n/catalog";
import { useAppStore } from "@/store/appStore";
import type { ServiceModel } from "@/utils/serviceModel";
import { fireAndForget } from "@/utils/frontendLog";

interface ServiceRemediesProps {
  model: ServiceModel;
  /** The tunnel's SSH connection, for "Edit connection" and "Open a terminal". */
  sshConnectionId?: string;
  /** Before a step leaves this place for the service's editor. */
  onLeave?: () => void;
}

/**
 * The next steps of a service and its Activity, outside the Services view: in
 * Open connections (#6028, slice 10). The same steps as its row and its Activity.
 */
export function ServiceRemedies({ model, sshConnectionId, onLeave }: ServiceRemediesProps) {
  const showIn = useEditorViews((s) => s.show);
  const openTunnelEditorTab = useAppStore((s) => s.openTunnelEditorTab);
  const openServerEditorTab = useAppStore((s) => s.openServerEditorTab);

  const open = (view: "settings" | "activity") => {
    onLeave?.();
    showIn(model.id, view);
    if (model.kind === "tunnel") openTunnelEditorTab(model.id);
    else openServerEditorTab(model.id);
  };
  const take = useServiceNextStep(model, {
    edit: () => open("settings"),
    // Another port is a change to look at: in its editor.
    listenOn: () => open("settings"),
    sshConnectionId,
  });

  const ids = `oc-service-${model.id}`;
  return (
    <span className="oc-row__remedies" data-testid={`${ids}-remedies`}>
      {model.nextSteps.map((step) => (
        <Button
          key={step.id}
          variant="ghost"
          size="sm"
          onClick={() => fireAndForget(Promise.resolve(take(step)), `${step.id} ${model.id}`)}
          data-testid={`${ids}-next-${step.id}`}
        >
          {step.label}
        </Button>
      ))}
      <Button
        variant="ghost"
        size="sm"
        icon={<Activity size={12} />}
        onClick={() => open("activity")}
        data-testid={`${ids}-activity`}
      >
        {t("service.action.activity")}
      </Button>
    </span>
  );
}
