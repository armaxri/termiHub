### Added

- Network diagnostic tools (**ping**, **traceroute**, **port scan**, **DNS
  lookup**, **Wake-on-LAN**) can now run on a **remote agent** instead of the
  desktop, so a probe reflects the agent's network vantage rather than the
  desktop's (part of the agent-centric stateless-UI port, #2154 / #2139). Where a
  tool runs is a per-tool desktop-side preference (`set_network_tool_run_location`);
  when it resolves to an agent, the desktop proxies the call to the agent's
  existing `network.*` methods and surfaces the results through the **same events**
  as a local run. Every tool still defaults to **This computer**, so this is
  strictly opt-in with no behaviour change until the run-location selector UI
  (#2191) records a non-default choice. The **HTTP monitor** stays desktop-only —
  the agent has no HTTP-monitor method, so it is never offered an agent.
