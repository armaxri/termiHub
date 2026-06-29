import { ArrowRight } from "lucide-react";

interface JumpHostPathDisplayProps {
  /** Ordered hop host labels, outermost → innermost. */
  hops: string[];
  /** The final target host label. */
  target: string;
}

/**
 * Visual summary of an SSH jump-host connection path:
 * `You → bastion → target`. Empty hop/target labels fall back to placeholders
 * so the line stays readable while the user is still typing.
 */
export function JumpHostPathDisplay({ hops, target }: JumpHostPathDisplayProps) {
  const nodes = ["You", ...hops.map((h) => h.trim() || "jump host"), target.trim() || "target"];

  return (
    <div className="jump-host__path" data-testid="jump-host-path">
      <span className="jump-host__path-label">Connection path</span>
      <span className="jump-host__path-chain">
        {nodes.map((node, i) => {
          const isTarget = i === nodes.length - 1;
          return (
            <span className="jump-host__path-node-wrap" key={i}>
              {i > 0 && <ArrowRight className="jump-host__path-arrow" size={12} aria-hidden />}
              <span
                className={
                  isTarget
                    ? "jump-host__path-node jump-host__path-node--target"
                    : "jump-host__path-node"
                }
              >
                {node}
              </span>
            </span>
          );
        })}
      </span>
    </div>
  );
}
