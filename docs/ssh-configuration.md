# SSH Configuration

This guide covers SSH connection setup in termiHub, including key-based authentication, X11 forwarding, and the SFTP file browser.

---

## Authentication Methods

termiHub supports two SSH authentication methods:

### Password Authentication

When **Auth Method** is set to **Password**, termiHub prompts for the password each time you connect. Passwords are never stored in the configuration file.

### Key-Based Authentication

When **Auth Method** is set to **SSH Key**, you provide a path to your private key file. This is the recommended method for frequent connections.

**Settings:**
- **Key Path** — Absolute path to your private key file (e.g., `~/.ssh/id_rsa`). The `~` prefix is expanded to your home directory.

---

## Setting Up SSH Keys

If you don't already have an SSH key pair, generate one:

### Generate a Key Pair

```bash
ssh-keygen -t ed25519 -C "your_email@example.com"
```

When prompted:
- **File location**: Press Enter to accept the default (`~/.ssh/id_ed25519`), or specify a custom path
- **Passphrase**: Enter a passphrase for extra security, or press Enter for no passphrase

This creates two files:
- `~/.ssh/id_ed25519` — Your private key (keep this secret)
- `~/.ssh/id_ed25519.pub` — Your public key (install on servers)

**Note**: You can also use RSA keys (`ssh-keygen -t rsa -b 4096`). termiHub supports both key types.

### Install the Public Key on the Server

Copy your public key to the remote server:

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub user@hostname
```

Or manually append it to `~/.ssh/authorized_keys` on the server:

```bash
cat ~/.ssh/id_ed25519.pub | ssh user@hostname 'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys'
```

### Configure in termiHub

1. Create or edit an SSH connection
2. Set **Auth Method** to **SSH Key**
3. Set **Key Path** to the path of your private key (e.g., `~/.ssh/id_ed25519`)
4. Save and connect

---

## Platform-Specific Key Setup

### macOS

macOS includes a built-in SSH agent and Keychain integration.

**Add your key to the SSH agent and Keychain:**

```bash
ssh-add --apple-use-keychain ~/.ssh/id_ed25519
```

To load keys automatically on login, add to `~/.ssh/config`:

```
Host *
  AddKeysToAgent yes
  UseKeychain yes
  IdentityFile ~/.ssh/id_ed25519
```

**Key location**: Keys are typically stored in `~/.ssh/`. Use this path in termiHub's Key Path field.

### Linux

**Start the SSH agent** (if not already running):

```bash
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519
```

To start the agent automatically, add to your shell profile (`~/.bashrc` or `~/.zshrc`):

```bash
if [ -z "$SSH_AUTH_SOCK" ]; then
  eval "$(ssh-agent -s)"
  ssh-add ~/.ssh/id_ed25519
fi
```

**Key permissions**: Ensure correct permissions on your key files:

```bash
chmod 700 ~/.ssh
chmod 600 ~/.ssh/id_ed25519
chmod 644 ~/.ssh/id_ed25519.pub
```

### Windows

**Using OpenSSH Agent** (built-in to Windows 10+):

1. Open **Services** (Win+R, type `services.msc`)
2. Find **OpenSSH Authentication Agent**, set it to **Automatic**, and start it
3. Add your key:

   ```powershell
   ssh-add $env:USERPROFILE\.ssh\id_ed25519
   ```

**Key location**: Keys are typically stored in `C:\Users\<username>\.ssh\`. In termiHub, you can use either:
- `~/.ssh/id_ed25519` (the `~` prefix works)
- `C:\Users\<username>\.ssh\id_ed25519`

---

## X11 Forwarding

X11 forwarding lets you run graphical applications on a remote server and display them on your local machine.

### Enabling X11 Forwarding

1. Edit an SSH connection in termiHub
2. Check **Enable X11 Forwarding**
3. Save and connect

When connected, run a graphical application on the remote server (e.g., `xclock`, `xeyes`, `firefox`) and its window will appear on your local display.

### Platform Requirements

#### macOS

Install [XQuartz](https://www.xquartz.org/) (the X11 server for macOS):

```bash
brew install --cask xquartz
```

After installing, **log out and log back in** (or restart). XQuartz must be running before connecting with X11 forwarding.

**Verify XQuartz is working:**

```bash
# After installing and restarting
echo $DISPLAY
# Should output something like: /private/tmp/com.apple.launchd.xxxx/org.xquartz:0
```

#### Linux

X11 is typically pre-installed on desktop Linux distributions. Ensure `xauth` is installed:

```bash
# Ubuntu/Debian
sudo apt install xauth

# Fedora
sudo dnf install xorg-x11-xauth

# Arch
sudo pacman -S xorg-xauth
```

No additional setup is needed — termiHub will use your existing X11 display.

#### Windows

X11 forwarding is **not currently supported** on Windows. termiHub's X11 proxy relies on Unix domain sockets, which are not available on Windows.

For Windows users needing to run remote GUI applications, consider using a standalone X server like [VcXsrv](https://sourceforge.net/projects/vcxsrv/) with a standard SSH client.

### Server-Side Requirements

The SSH server must have X11 forwarding enabled. Check `/etc/ssh/sshd_config` on the server:

```
X11Forwarding yes
X11DisplayOffset 10
```

The `xauth` package must also be installed on the server.

---

## SFTP File Browser

When connected to an SSH server, termiHub provides an integrated SFTP file browser for managing remote files.

### Auto-Connect

When you click on an SSH terminal tab, the file browser in the sidebar automatically connects to the remote server via SFTP. No manual connection step is needed.

### Features

- **Browse** remote directories
- **Upload** files by clicking the Upload button or dragging files from your OS file manager
- **Download** files via right-click context menu
- **Create** files and directories
- **Rename** and **delete** files and directories
- **Edit** remote files in the built-in editor (changes are saved back via SFTP)
- **Open in VS Code** — downloads the file to a temp location and opens it

### File Information

The file browser shows:
- File name
- File size (formatted as B, KB, MB)
- File permissions in Unix `rwx` notation

See the [User Guide](user-guide.md#file-browser) for more details on the file browser interface.

---

## Connection Settings Reference

| Field | Description | Default |
|-------|-------------|---------|
| Host | Server hostname or IP address | — |
| Port | SSH port | 22 |
| Username | Remote username | — |
| Auth Method | `password` or `key` | password |
| Key Path | Path to private key (when using key auth) | — |
| Enable X11 Forwarding | Forward remote GUI apps to local display | Off |

### Environment Variable Placeholders

You can use `${env:VAR}` syntax in any field:

```
Host: ${env:MY_SERVER}
Username: ${env:USER}
Key Path: ${env:HOME}/.ssh/id_ed25519
```

This is useful for shared connection configurations where values differ per user.

---

## Troubleshooting

### "Connection refused"

- Verify the SSH server is running on the target: `systemctl status sshd`
- Check the port is correct (default: 22)
- Test with the standard `ssh` command: `ssh -p 22 user@host`
- Check firewall rules on the server

### "Authentication failed"

- **Password auth**: Verify the username and password are correct
- **Key auth**: Ensure the public key is in `~/.ssh/authorized_keys` on the server
- **Key permissions**: Check that your private key file has `600` permissions
- **Wrong key**: Verify the Key Path in termiHub points to the correct private key

### "Host key verification failed"

This occurs when connecting to a new server or when the server's host key has changed. termiHub uses the system's `known_hosts` file. To resolve:

```bash
# Connect once with standard SSH to accept the host key
ssh user@hostname
# Type 'yes' when prompted to add the key
```

### X11 forwarding not working

- **macOS**: Ensure XQuartz is installed and running. Log out and log back in after installing XQuartz.
- **Linux**: Ensure `xauth` is installed and `$DISPLAY` is set
- **Server**: Check that `X11Forwarding yes` is set in `/etc/ssh/sshd_config`
- **Server**: Ensure `xauth` is installed on the server
- Test with standard SSH: `ssh -X user@host xclock`

### SFTP connection fails

- SFTP uses the same SSH connection — if SSH works, SFTP should too
- Ensure the SSH server has SFTP enabled (check for `Subsystem sftp` in `/etc/ssh/sshd_config`)
- Some restricted shells may block SFTP — check with your server administrator
