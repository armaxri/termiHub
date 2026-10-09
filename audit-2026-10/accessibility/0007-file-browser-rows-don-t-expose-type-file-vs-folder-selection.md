---
id: A11Y2-007
title: "File browser rows don't expose type (file vs folder), selection state, or sort state"
angle: accessibility
severity: medium
category: screen-reader
is_workaround: false
subsystem: "src/components/Sidebar/FileBrowser"
evidence:
  - src/components/Sidebar/FileBrowser.tsx:483-501
  - src/components/Sidebar/FileBrowser.tsx:639-674
  - src/components/Sidebar/FileBrowser.tsx:2066-2070
  - src/components/Sidebar/FileBrowser.tsx:462-470
status: fixed
resolution: "#4349 — rows name their type and expose aria-pressed in a named list; sort state is in the header name"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

Each row is a <button> whose accessible name is just the filename. FileEntryIcon (Folder, File and symlink glyphs) has no text alternative, so folders, files and symlinks sound the same. Multi-selection (isSelected, shown only by the --selected class at :633) has no aria-selected or aria-pressed. The list container has no role (list, listbox or grid) and no name, although it has roving tabIndex and arrow-key handling. The column sort headers put aria-sort on a <button>; aria-sort is only valid on columnheader/rowheader, so screen readers ignore it and the sort direction is not exposed. Compare TransferPane, which correctly uses role=listbox/option, aria-selected and aria-activedescendant.

## Why it matters

WCAG 1.3.1 Info and Relationships (A) and 4.1.2 (A). A screen-reader user browsing a remote host cannot tell which entries are directories they can enter, cannot confirm what is selected before Delete or Move to…, and cannot hear the sort order. That is risky for destructive bulk file operations.

## Recommendation

Make the list role="listbox" aria-multiselectable="true" aria-label="Files in <path>", and each row role="option" aria-selected={isSelected} (or keep the buttons and add aria-pressed). Append the type to the name via visually-hidden text or aria-label (`${name}, folder` / `, symbolic link to …`). For sorting, either give the header row role="row" with role="columnheader" cells carrying aria-sort, or drop aria-sort and put the state in the button name ("Name, sorted ascending").

## Verification

Confirmed. FileEntryIcon glyphs have no text, rows (buttons) have no aria-selected/aria-pressed, and the list div has no role. aria-sort sits on a <button>, where it is invalid. One mitigation: a symlink's visible '-> target' text is part of the row name, so symlinks with a known target are partly distinguishable.
