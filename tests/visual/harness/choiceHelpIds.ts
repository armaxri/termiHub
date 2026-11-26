/**
 * Ids of the saved connections the choice-help scenario seeds (#6036). A plain
 * module so both the browser mock and the Node spec can import it.
 */
export const CHOICE_HELP_CONNECTIONS = {
  serial: "Work/Bench console",
  rdp: "Work/Build desktop",
  vnc: "Work/Lab screen",
  hop: "Work/Behind gateway",
} as const;
