## Security

- The password of a Remote Desktop (VNC / RDP) connection saved under a remote agent is no longer stored on the agent host. It is kept in this computer's credential store when "Save password" is on, or asked for when you connect. Connections saved with a password before this change have it moved into this computer's credential store and removed from the agent host automatically the next time the agent's connections are loaded. If no credential store is set up, the password is removed from the agent host and asked for at connect time.
