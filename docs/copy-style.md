# Copy Style Guide

How termiHub words the text it shows: dialog titles, buttons, menu items, Settings labels,
tooltips, toasts and messages. One rule per question, so every dialog reads the same way and
nobody has to re-read a footer to find the action. Adopted by the maintainer on 2026-11-11
([#5391](https://github.com/armaxri/termiHub/issues/5391), audit finding UX-028).

The mechanically checkable parts are enforced by ESLint; see [Enforcement](#enforcement).

## Sentence case

Dialog titles, buttons, menu items, tabs, tooltips, **Settings labels**, accessible names
(`aria-label`) and the titles of errors and toasts use sentence case. Capitalize the first word
and proper nouns, nothing else. A screen reader announces an `aria-label` exactly as written, so
it follows the same rule as the visible text.

| Do                          | Don't                       |
| --------------------------- | --------------------------- |
| Allow experimental features | Allow Experimental Features |
| Unsaved changes             | Unsaved Changes             |
| Clear history               | Clear History               |
| Save and connect            | Save & Connect              |
| Open SSH session            | Open SSH Session            |
| Use PowerShell on Windows   | Use powershell on windows   |

- Proper nouns keep their capitals: product and platform names (termiHub, PowerShell, Windows,
  macOS, Docker, Git), protocols and acronyms (SSH, SFTP, WSL, RDP, VNC), and key names (Ctrl,
  Shift, Enter).
- A user's own names (a connection called "My Server") keep the capitals the user typed. Quote
  them in prose: `Delete "My Server"?`.
- Text that names another control quotes it, like a user's name: "Click “Refresh” to list
  ports".
- A new sentence after `.`, `:`, `!` or `?` starts with a capital: "Saved. Reconnect to apply".
- Do not write copy in capitals to style it. Headings that should look uppercase use CSS
  (`text-transform`), and the source string stays in sentence case; screen readers and
  Settings search then see the real words.

## Buttons and footers

One primary button per footer. Cancel is on the left; the primary action is on the right.

| Do                                 | Don't                                           |
| ---------------------------------- | ----------------------------------------------- |
| Cancel · Test · **Save**           | Cancel · Test · **Save and connect** · **Save** |
| Cancel · **Delete**                | **Delete** · Cancel                             |
| Cancel · Save and start · **Save** | **Save** · Save and start · Cancel              |

- A `<Button>` without a `variant` is primary, so the others in the footer say
  `variant="secondary"` (or `"ghost"`).
- The primary is the action the user most likely wants, and Enter runs it. A new
  connection is saved to be used, so its editor reads Cancel · Test · Save ·
  **Save and connect**; editing an existing connection keeps **Save** primary (#5755).
  Tunnels follow the same rule: a new tunnel reads Cancel · Save · **Save and start**,
  and editing an existing tunnel keeps **Save** primary (#5810). Automations
  differ (#6025): **Save** is the primary of a new one too, because running types into a terminal;
  **Save and run** beside it names that terminal.
- Enter runs the primary from a form's own single-line fields, not from the rows of a list inside
  it: Enter after typing an automation step's command must not run the unfinished automation.
- Label a button with a verb that says what happens: "Delete connection", "Save", "Reconnect".
  Avoid "Yes" and "No".

## Acknowledging

- **Close** dismisses an informational dialog, banner or notice that asks nothing.
- **OK** only confirms a choice the dialog made for the user, and only where no specific verb
  fits. Prefer the verb: "Restore", "Apply", "Continue".
- Do not use **Done**, **Dismiss**, **Got it** or **Okay** for the same role.
- **Later** puts off an offer whose text itself talks about closing something, so
  **Close** would read as "close that". The agent update strip says "Waits for 1 session
  (bash) to close." and offers **Later** beside "Restart agent and update" (#5980).

| Do                                                 | Don't                                             |
| -------------------------------------------------- | ------------------------------------------------- |
| Import finished. 12 connections added. · **Close** | Import finished. 12 connections added. · **Done** |
| Agent update available · **Later**                 | Agent update available · **Dismiss**              |

## Toasts: only what the screen does not show

Feedback is visible in place; a toast only when it isn't (maintainer decision on
[#5859](https://github.com/armaxri/termiHub/issues/5859)). A saved form that closes and shows its
row, a tab that opens connected, a toggle that flips, an automation that types into the visible terminal:
none of these toast. Toasts are for:

- **Failures** — always, and they stay until dismissed.
- **Background events** — a transfer, a scheduled or automatic run, a reconnect, anything that
  finishes off-screen or outside termiHub (the clipboard, a file on disk).
- **Undo offers** — "Closed “web” · Reopen", "Deleted folder “prod” · Undo". They use the
  neutral info style, never the green success one: the action button is the point of the toast.
  A toast for several items names the first three, then "+N more".
- **Why nothing happened** — an info toast when an action changed nothing visible ("No dead agents
  to prune").

Inside an open dialog, success and info messages show in the dialog's own status line instead. A
result with no other on-screen state shows in an `InlineStatus` line beside its button (the
connection editor's "Reached web — Nothing was saved.").

Opening a dialog dismisses the success and info confirmations still showing: old feedback never sits
beside a new decision. Undo offers (any toast with a button) are not lost that way
([#5914](https://github.com/armaxri/termiHub/issues/5914)): they hide while the dialog is open and
come back, with the time they had left, once it closes. Only a toast raised with `dismissOnModal`
goes for good; no toast uses it today.

Every `toast.success`, `toast.info` and `toast.promise` call carries a `// toast-policy: <reason>`
comment naming why it is not visible in place (`background`, `off-screen`, `undo`,
`no-in-place-surface`, `dialog-status`, `explains-outcome`). `src/components/ui/Toast/toastPolicy.test.ts`
fails on an untagged call, so a new success toast always comes with its justification.

## Discarding unsaved changes

The button that throws away unsaved edits says **Discard changes**, everywhere.

| Do              | Don't                                            |
| --------------- | ------------------------------------------------ |
| Discard changes | Just close · Close anyway · Discard · Don't save |

"Anyway" is fine where it is not about unsaved edits, for example "Connect anyway" after a
warning, but say what is being overridden in the dialog text.

## Credential storage names

Name the credential storage options exactly as their option cards do, wherever text points at
them: **OS Keychain**, **Master password** and **Don't save passwords**
([#5685](https://github.com/armaxri/termiHub/issues/5685)). "OS Keychain" keeps its capital K
everywhere ("stored in the OS Keychain"). Text that refers to the options takes the labels from
`CREDENTIAL_STORAGE_CHOICES` (`src/utils/credentialStorageCopy.ts`) instead of retyping them.

| Do                                           | Don't                                        |
| -------------------------------------------- | -------------------------------------------- |
| choose OS Keychain or Master password        | choose Master Password or OS Keychain        |
| Passwords will be stored in the OS Keychain. | Passwords will be stored in the OS keychain. |

## Delete vs Remove

- **Delete** destroys data: a saved connection, a key file, a credential. It cannot be undone
  without a backup, so it usually asks for confirmation.
- **Remove** takes something out of a list, group or view without destroying it: remove a
  connection from a folder, remove a tab from a group, remove a recent entry.

| Do                                           | Don't                                    |
| -------------------------------------------- | ---------------------------------------- |
| Delete connection (removes the saved config) | Remove connection (when it is destroyed) |
| Remove from favorites                        | Delete from favorites                    |

## Ellipsis

Use the ellipsis character `…`, never three dots `...`. A menu item or button ends in `…` when
it opens a dialog that asks for more input before acting ("Export…"); progress text ends in `…`
too ("Saving…"). Enforced since [#5379](https://github.com/armaxri/termiHub/issues/5379).

## US spelling

termiHub uses US English.

| Do                    | Don't                 |
| --------------------- | --------------------- |
| canceled, canceling   | cancelled, cancelling |
| color, behavior       | colour, behaviour     |
| favorite, center      | favourite, centre     |
| initialize, customize | initialise, customise |
| license (noun)        | licence               |

"Cancellation" has two l's in US English too.

## List rows: names, not settings

> "Users are looking for names and maybe for a short description, but not the settings."
> (maintainer, 2026-11-13, [#5757](https://github.com/armaxri/termiHub/issues/5757))

A row in a sidebar or list (connections, automations, agents, tunnels,
services, HTTP monitors, plugins) shows:

- **The name the user gave the item.**
- **Its short description**, when the user wrote one: muted, one line, under the name. A
  description is optional, single line and at most 80 characters
  (`ITEM_DESCRIPTION_MAX_LENGTH` in `src/utils/itemDescription.ts`). No description, no line.
- **A compact state marker, only when the state needs attention:** running, error or failed,
  waiting, cannot run, connected, disabled, paused. A routine state that the dot already says
  ("connected") is not a marker.
- **Its run control, when the list exists to run things:** an automation's Run, a tunnel's or
  service's Start / Stop (Retry after an error). It stays visible at rest on the row's
  trailing edge (`SidebarListItem`'s `primaryAction`); the other actions show on hover.
  A status dot names its state in a tooltip and as its accessible name ("Stopped",
  "Running", "Error"; a plugin's "Enabled", "Disabled", "Error"), and so does a leading
  type icon ("Protocol parser").

**Services** (SSH tunnels and file servers) say three things more, because a name alone does not
tell what one is for or how to use it (maintainer, 2026-11-25,
[#6028](https://github.com/armaxri/termiHub/issues/6028)): their state and what they are for in plain
words ("Running · Open a folder in a browser"), the machine when that is not this computer, and,
only while they run, the address with Copy. Why one does not run takes the address's place. Nothing
on the row is cut: it wraps, and an address or a machine's name that does not fit loses its middle.
The row is `ServiceListItem`, its words are in `serviceModel.ts`. Rules for them
([#6063](https://github.com/armaxri/termiHub/issues/6063)):

- The **state comes first**. What it is for names the ends ("Reach db through Build Box")
  and what others may really do ("Download only", "Download and upload"). The user's description
  takes its place. The technical name is at the end of the name's line ("Local", "FTP").
- The **machine is named once**, under the name, on every row that runs elsewhere and on no other.
  Reasons say "its agent".
- The address says **who reaches it**: "only this computer", "anyone on your network with the
  password", "only on that machine". An address nobody knows is said with its reason and the port,
  never a `localhost` that is wrong for the reader.
- **A remedy is a button** beside the reason, when it can be done now: Use 8081, Edit, Connect agent,
  Unlock, Edit connection, Retry now. The reason does not repeat it in words.
- **Red** is for what needs the user, **amber** for what moves or is in doubt, a grey ring for what
  waits by itself.
- The run button is a filled square (Stop) or triangle (Start). Giving up waiting or starting is the
  word Cancel. Two actions never share a name; one that was pressed is not offered again.
- The **New menu asks what it is for** ("Reach something through a server"), with an example and the
  technical name under it. The search finds all of these words.
- An **offline agent** with several services is said once, with all of them, whatever kind they are.
- A **group's line says its problems**, also while it is closed; only without any it says how many run.
- An **editor is a tab** (`ServiceEditorShell`): titled by what the user wants to do, the fields one came
  for first, Save always on screen with the reason beside it while it cannot save. Who can open it is
  said in words, with the address that comes out of it. A **new file server is for this computer only and
  to download**, and whenever others can reach one, an amber warning says who and what they can do.
- **A port is preset free**: an editor never presets a port that another service of this computer is set
  to, and says it of a typed one with the free one beside it ("Port 8080 is used by "Release builds". Use
  8081"). Where devices expect a port of their own (TFTP, 69), the editor says so and what opening it
  needs.
- **Delete is undone, not warned about**: the same dialog and the same Undo for both kinds. It says what
  breaks ("1 open connection") and, of a file server, that the folder and its files stay.
- A **list says in numbers** what its rows say: running, error, not known, reconnecting, waiting.
  Pressing a number shows only its rows, and says so ("Only errors.") with Show all. "Not known" is what may run: it is never counted as off.
- **Stop and Restart ask only when someone is connected** right now, and say how many. So do Stop all
  and quitting, which names each service that stops and its agent.
- An **empty list** says what its things are for and what they need.

Everything else is configuration or history and goes in the row's **tooltip**, the editor or a
detail view, never on the row: host, user and port, the trigger and its target, step or command
previews, the last run and where it went, prefixes, tags. Pass these lines to
`SidebarListItem`'s `tooltip` prop; they show in a tooltip on the name and are the row's
accessible description.

| Do                                   | Don't                                             |
| ------------------------------------ | ------------------------------------------------- |
| Prod web · _Main shop front_         | Prod web · _deploy@10.0.0.4:22\_                  |
| Release check                        | Release check · _echo start_ · _Last run: 5m ago_ |
| Prod DB (dot: connected)             | Prod DB · LOCAL · _127.0.0.1:5432 → db:5432_      |
| Docs share · _Error: port in use_    | Docs share · HTTP · _:8080 → /srv/docs_           |
| Build box (dot: connected)           | Build box · v0.4.1 ✓                              |
| Shop health (dot: down) · _Down_     | shop.example.com/health · ✗ down · 2m ago         |
| Log colorizer · _Colours log levels_ | Log colorizer · v0.3.0                            |

**A schedule's row is the exception** (#6024): the list exists to answer when something runs by
itself, what, where, and whether the last run happened. Its row says its state with the next run
and the rule, the automation and the connections, why it will not run, and the last run with the
whole reason. Those lines wrap and are never cut. Its switch shows on and off; a coloured dot
always means an outcome. A schedule is **On**, **Off** or **Paused**, never "enabled" or "armed".

**An automation's row is the other exception** (#6026): one decides there whether something may
type by itself. Under its name it says, in sentences, which hotkeys and triggers start it
("Triggers on: hotkey F8, connecting to prod"), or what does not while they are off and that it
can still be run, with their switch; when a schedule runs it next; in which terminal it runs and
at which step; and why it cannot run. An automation is never "off" or "armed": its **triggers** are
**on** or **off**. Progress is the step it is at ("step 2 of 3", "2/3" on a tab) or the share of the keys
("50 % typed"), never the steps that are done. The verbs are **Run**, **Record** and **Stop** (a stopped run is "Stopped", not
"canceled"). What it types, its last run and its tags stay in the tooltip.

Not list rows, so this rule does not apply: location context that says where a view is (the
file browser's host label), detail areas (the status bar's SSH and serial chips, a service's
activity panel) and naming parts that tell two items apart (a duplicate tab's "(2)"). A choice
that configures the item ("Run on") goes in its editor, not on the row.

The product run grades this in `tests/system/tests/test_product_run_rows_names.py`.

## Changing existing copy

- Update every test, system test and visual expectation that asserts the old string.
- When a Settings label changes, add the old phrasing to that setting's `keywords` in
  `src/components/Settings/settingsRegistry.ts`, so Settings search still finds it.

## Enforcement

ESLint enforces the mechanically checkable rules on production frontend code (`src/`, not tests)
through the local rule in
[`scripts/internal/eslint-copy-style.mjs`](../scripts/internal/eslint-copy-style.mjs):

| Check             | What it flags                                                                      |
| ----------------- | ---------------------------------------------------------------------------------- |
| `sentence-case`   | A capitalized word after the first word of a label, title, tooltip or `aria-label` |
| `acknowledgement` | A button labeled Done, Dismiss, OK, Okay or Got it                                 |
| `discard`         | A discard button labeled anything but "Discard changes"                            |
| `us-spelling`     | British spelling in any user-facing string                                         |
| `one-primary`     | Two primary `<Button>`s that can render together in one parent                     |
| `cancel-left`     | A "Cancel" `<Button>` that is not the first button in its parent                   |
| (ellipsis, #5379) | Three dots `...` in user-facing text                                               |

The sentence-case check knows a list of proper nouns (`PROPER_NOUNS` in the rule). Acronyms and
mixed-case names (SSH, termiHub, PowerShell) never match, so they need no entry. Add a word to
the list only when it is a name; a multi-word name ("VS Code") goes in `PROPER_PHRASES`.

Since [#5493](https://github.com/armaxri/termiHub/issues/5493) the sentence-case check also covers
accessible names and tooltips (the `aria-label`, `title`, `tooltip` and `heading` attributes, and
`content` on a `<Tooltip>`) and `title:` keys in objects, which is where error, toast and dialog
descriptors keep their titles (for example `classifyAgentError`).

Menu items are the text of `MenuItem`, `MenuCheckboxItem`, `MenuRadioItem`, `MenuSubTrigger` and
`MenuLabel` from `src/components/ui/Menu.tsx` (or a raw Radix `*.Item`), plus `label:` fields of
menu and command descriptors. Text inside a nested component (an icon, a shortcut hint) is not
checked as the label. The native macOS app menu (Rust) follows Apple's Title Case convention and
is not linted.

When a flagged string is a deliberate exception (an OK that confirms a choice, a product name
the list does not know), disable the rule on that line with a reason:

```tsx
{
  /* eslint-disable-next-line copy/copy-style -- OK confirms the restored defaults */
}
<Button>OK</Button>;
```

### The baseline

The copy written before this guide still has violations. They are grandfathered in
[`scripts/internal/copy-style-baseline.json`](../scripts/internal/copy-style-baseline.json),
keyed by file, check and text, with an occurrence count. The lint fails on a violation that is not
in the baseline, so new copy must follow the guide. The baseline only shrinks:

```bash
node scripts/internal/copy-style-baseline.mjs           # list current violations by area
node scripts/internal/copy-style-baseline.mjs --check   # exit 1 if entries are already fixed
node scripts/internal/copy-style-baseline.mjs --prune   # delete fixed entries (never adds)
```

After fixing copy, run `--prune` and commit the smaller baseline with the fix. Do not run
`--write` to make a new violation pass: it rewrites the baseline from scratch and grandfathers
everything.
