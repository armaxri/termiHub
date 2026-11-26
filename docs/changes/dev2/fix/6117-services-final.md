### Fixed

- Sharing a folder from the file browser asks who may open the share instead of presetting "Only
  this computer", which made a share nobody else could open; a running share that only this
  computer reaches offers **Let others reach it**. (#6117)
- Open connections no longer focuses a destructive button: **Close** has the focus, the bulk
  buttons read **Stop all…**, services use the Services' state words, an errored one offers
  **Retry** instead of Stop, and its whole reason shows on its own line. (#6117)
- A service's how-to follows where it can be reached: one that works only on an agent's machine
  no longer says to open it here. (#6117)
- Addresses no longer break inside the host or IP address; a long one loses its middle and keeps
  its port, with Copy right beside it. (#6117)
- The status bar shows a tunnel that is reconnecting. (#6117)
- Stopping a service in use says who it cuts off, and Stop all names each service in use. (#6117)
- Smaller wording fixes in Services: the offline agent line, one clock format, the SSH server's
  name on a tunnel's path, and an editor of a running service says it is running and offers "Save,
  apply later". (#6117)
