import type { ReactNode } from "react";
import { Minus, Plus, ShieldPlus } from "lucide-react";
import type {
  PluginAccessDelta,
  PluginAccessDiff,
  PluginConnectionPolicyChange,
} from "@/types/plugin";
import { PERMISSION_DESCRIPTIONS, PERMISSION_LABELS } from "./pluginPresentation";
import {
  accessDiffAddsAccess,
  accessDiffIsEmpty,
  describeConnectionPolicy,
  describeDiffPath,
} from "./pluginAccessDiff";

/** Props for {@link PluginAccessDiffSection}. */
export interface PluginAccessDiffSectionProps {
  /** The access diff against the installed copy (from `preview_plugin`). */
  diff: PluginAccessDiff;
  /** The installed copy's version. */
  installedVersion: string;
  /** The incoming package's version. */
  incomingVersion: string;
}

type Side = "added" | "removed";

/** One row of a diff list: icon, bold name, secondary detail. */
function DiffRow({
  side,
  name,
  detail,
  testId,
}: {
  side: Side;
  name: string;
  detail: ReactNode;
  testId: string;
}) {
  const Icon = side === "added" ? Plus : Minus;
  return (
    <li className="plugin-access-diff__item" data-testid={testId}>
      <Icon className="plugin-access-diff__icon" aria-hidden="true" />
      <div>
        <span className="plugin-access-diff__name">{name}</span>{" "}
        <span className="plugin-access-diff__detail">— {detail}</span>
      </div>
    </li>
  );
}

/** The rows of one side: permissions, folders, then the connection policy. */
function DiffList({
  side,
  delta,
  policy,
}: {
  side: Side;
  delta: PluginAccessDelta;
  policy: PluginConnectionPolicyChange | null;
}) {
  const prefix = `plugin-install-access-${side}`;
  return (
    <ul className="plugin-access-diff__list" data-testid={prefix}>
      {delta.permissions.map((perm) => (
        <DiffRow
          key={perm}
          side={side}
          name={PERMISSION_LABELS[perm]}
          detail={PERMISSION_DESCRIPTIONS[perm]}
          testId={`${prefix}-perm-${perm}`}
        />
      ))}
      {delta.filesystemPaths.map((path) => (
        <DiffRow
          key={path.folder}
          side={side}
          name="Folder"
          detail={<span className="plugin-access-diff__path">{describeDiffPath(path)}</span>}
          testId={`${prefix}-path`}
        />
      ))}
      {policy && (
        <DiffRow
          side={side}
          name="Connection policy"
          detail={
            side === "added"
              ? `${describeConnectionPolicy(policy.before)} → ${describeConnectionPolicy(policy.after)}`
              : `${describeConnectionPolicy(policy.before)} (back to host defaults)`
          }
          testId={`${prefix}-policy`}
        />
      )}
    </ul>
  );
}

/**
 * The access an update or re-install changes against the installed copy
 * (#4418), shown in the install dialog: what the incoming version adds,
 * prominently under an "asks for more access" banner, and what it no longer
 * requests, as a secondary list. Renders nothing when the access is unchanged.
 *
 * A changed connection policy the incoming version still declares is listed as
 * added (as the native trust row does); one it drops is listed as removed.
 */
export function PluginAccessDiffSection({
  diff,
  installedVersion,
  incomingVersion,
}: PluginAccessDiffSectionProps) {
  if (accessDiffIsEmpty(diff)) return null;
  const adds = accessDiffAddsAccess(diff);
  const policy = diff.connectionPolicy;
  const policyAdded = policy !== null && policy.after !== null ? policy : null;
  const policyRemoved = policy !== null && policy.after === null ? policy : null;
  const removes =
    diff.removed.permissions.length > 0 ||
    diff.removed.filesystemPaths.length > 0 ||
    policyRemoved !== null;
  const what = installedVersion === incomingVersion ? "This reinstall" : "This update";

  return (
    <section className="plugin-access-diff" data-testid="plugin-install-access-diff">
      {adds && (
        <div
          className="plugin-install__banner plugin-install__banner--warning"
          data-testid="plugin-install-access-more"
        >
          <ShieldPlus className="plugin-install__banner-icon" aria-hidden="true" />
          <div>
            <span className="plugin-install__banner-title">{what} asks for more access</span>{" "}
            <span className="plugin-install__banner-desc">
              — compared with the installed version {installedVersion}, it also requests:
            </span>
            <DiffList side="added" delta={diff.added} policy={policyAdded} />
          </div>
        </div>
      )}
      {removes && (
        <div className="plugin-access-diff__removed">
          <div className="plugin-install__perm-title">
            No longer requested (installed {installedVersion})
          </div>
          <DiffList side="removed" delta={diff.removed} policy={policyRemoved} />
        </div>
      )}
    </section>
  );
}
