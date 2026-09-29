## Fixed

- A Remote Desktop (VNC / RDP) connection now keeps its password when "Save password" is on (the option was called "Save to store" and was ignored for connections on this computer). The password is kept in this computer's credential store, never in the connections file, so the connection reconnects without asking. If nothing is saved yet, you are asked once and can save the answer. Deleting the connection removes the saved password. Connections saved with the old option are read as "Save password" on.
