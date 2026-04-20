import { useState, useCallback } from "react";
import { WifiOff, RefreshCw } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { AgentErrorMeta } from "@/types/terminal";
import { resolveConnectionCredential } from "@/utils/resolveConnectionCredential";
import "./AgentErrorTab.css";

interface AgentErrorTabProps {
  tabId: string;
  meta: AgentErrorMeta;
  isVisible: boolean;
}

/**
 * Shown in place of a terminal when a workspace agent connection cannot be established.
 * Styled like a terminal so it fits naturally in split panels and the zoom overlay.
 * The reconnect button re-attempts the full agent session and, on success, replaces
 * all error tabs for that agent with live terminal tabs.
 */
export function AgentErrorTab({ tabId: _tabId, meta, isVisible }: AgentErrorTabProps) {
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  const connectRemoteAgent = useAppStore((s) => s.connectRemoteAgent);
  const resolveAgentErrorTabs = useAppStore((s) => s.resolveAgentErrorTabs);

  const handleReconnect = useCallback(async () => {
    setIsReconnecting(true);
    setReconnectError(null);
    try {
      const storeState = useAppStore.getState();
      const agent = storeState.remoteAgents.find((a) => a.id === meta.agentId);
      let password: string | undefined;

      if (agent) {
        const needsStoredCredential =
          agent.config.authMethod === "password" ||
          (agent.config.authMethod === "key" && agent.config.savePassword);
        if (needsStoredCredential) {
          const credStatus = storeState.credentialStoreStatus;
          if (credStatus?.mode === "master_password" && credStatus?.status === "locked") {
            const unlocked = await useAppStore.getState().requestUnlock();
            if (!unlocked) {
              setIsReconnecting(false);
              return;
            }
          }
          const resolution = await resolveConnectionCredential(
            meta.agentId,
            agent.config.authMethod,
            agent.config.savePassword
          );
          if (resolution.usedStoredCredential && resolution.password) {
            password = resolution.password;
          }
        }
      }

      await connectRemoteAgent(meta.agentId, password);
      resolveAgentErrorTabs(meta.agentId);
    } catch (err) {
      setReconnectError(String(err));
      setIsReconnecting(false);
    }
  }, [meta.agentId, connectRemoteAgent, resolveAgentErrorTabs]);

  return (
    <div
      className={`agent-error-tab${isVisible ? "" : " agent-error-tab--hidden"}`}
      data-testid="agent-error-tab"
    >
      <div className="agent-error-tab__body">
        <WifiOff size={32} className="agent-error-tab__icon" />

        <p className="agent-error-tab__heading">Agent connection unavailable</p>

        <div className="agent-error-tab__details">
          <div className="agent-error-tab__row">
            <span className="agent-error-tab__label">Agent</span>
            <span className="agent-error-tab__value">{meta.agentName}</span>
          </div>
          <div className="agent-error-tab__row">
            <span className="agent-error-tab__label">Connection</span>
            <span className="agent-error-tab__value">{meta.definitionName}</span>
          </div>
          <div className="agent-error-tab__row">
            <span className="agent-error-tab__label">Reason</span>
            <span className="agent-error-tab__value agent-error-tab__value--error">
              {meta.error}
            </span>
          </div>
        </div>

        <div className="agent-error-tab__actions">
          <button
            className="agent-error-tab__reconnect-btn"
            onClick={handleReconnect}
            disabled={isReconnecting}
            data-testid="agent-error-reconnect-btn"
          >
            <RefreshCw size={14} className={isReconnecting ? "agent-error-tab__spin" : ""} />
            {isReconnecting ? "Reconnecting…" : "Reconnect"}
          </button>
          {reconnectError && (
            <span className="agent-error-tab__reconnect-error">{reconnectError}</span>
          )}
        </div>
      </div>
    </div>
  );
}
