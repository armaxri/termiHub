### Security

- Continue of a waiting automation reads the terminal that took over its tab during the check, holds
  back for a password prompt it saw while the terminal kept printing, and says when the terminal
  changed since "Continue anyway" was offered. A recorded key whose screen could not be read stays
  left out even when the prompt around it turns out to be none. (#6077)
