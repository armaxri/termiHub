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
- Label a button with a verb that says what happens: "Delete connection", "Save", "Reconnect".
  Avoid "Yes" and "No".

## Acknowledging

- **Close** dismisses an informational dialog, banner or notice that asks nothing.
- **OK** only confirms a choice the dialog made for the user, and only where no specific verb
  fits. Prefer the verb: "Restore", "Apply", "Continue".
- Do not use **Done**, **Dismiss**, **Got it** or **Okay** for the same role.

| Do                                                 | Don't                                             |
| -------------------------------------------------- | ------------------------------------------------- |
| Import finished. 12 connections added. · **Close** | Import finished. 12 connections added. · **Done** |
| Agent update available · **Close**                 | Agent update available · **Dismiss**              |

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

A row in a sidebar or list (connections, workflows, macros, schedules, agents, tunnels,
services) shows:

- **The name the user gave the item.**
- **Its short description**, when the user wrote one: muted, one line, under the name. A
  description is optional, single line and at most 80 characters
  (`ITEM_DESCRIPTION_MAX_LENGTH` in `src/utils/itemDescription.ts`). No description, no line.
- **A compact state marker, only when the state needs attention:** running, error or failed,
  armed/off, connected, disabled, paused. A routine state that the dot already says ("on,
  next run at 09:10") is not a marker.

Everything else is configuration or history and goes in the row's **tooltip**, the editor or a
detail view, never on the row: host, user and port, the trigger and its target, step or command
previews, the last run and where it went, prefixes, tags. Pass these lines to
`SidebarListItem`'s `tooltip` prop; they show in a tooltip on the name and are the row's
accessible description.

| Do                                     | Don't                                             |
| -------------------------------------- | ------------------------------------------------- |
| Prod web · _Main shop front_           | Prod web · _deploy@10.0.0.4:22\_                  |
| Answer on match · ⚡ Armed             | Answer on match · _On output match · prod-shell_  |
| Release check                          | Release check · _echo start_ · _Last run: 5m ago_ |
| Nightly backup (dot: on)               | Nightly backup · _Next: today 09:10_              |
| Nightly backup (dot: off) · _Disabled_ | Nightly backup · _Every day 09:10 · on db-1_      |

Not list rows, so this rule does not apply: location context that says where a view is (the
file browser's host label), detail areas (the status bar's SSH and serial chips) and naming
parts that tell two items apart (a duplicate tab's "(2)").

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
