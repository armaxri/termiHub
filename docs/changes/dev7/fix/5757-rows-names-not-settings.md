### Changed

- Sidebar and list rows show the name you gave an item, its short description
  when you wrote one, and only state markers that need attention. Settings and
  history moved into a tooltip on the name:
  - Workflow rows no longer show "Manual" / "On output match · …" / "Hotkey …"
    or tag chips; the Armed/Off marker and its switch stay.
  - Macro rows no longer show the first command or the "Last run: … on …"
    line or tag chips; Play stays visible. Run history is unchanged.
  - Schedule rows keep the state dot and show "Disabled", "Paused", "Running
    now" or "Not scheduled" only when that state needs attention, plus a "Last
    run failed" marker. The next run ("Next: today 09:10"), rule, targets and
    last result are in the tooltip; recent attempts open from an icon button.
- Workflow and macro descriptions are one line of at most 80 characters.
