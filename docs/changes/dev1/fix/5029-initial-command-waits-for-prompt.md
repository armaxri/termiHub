### Fixed

- A connection's initial command waits for the shell's prompt again in local
  bash, zsh and fish sessions and in SSH sessions without the command-mark hook.
  With a slow startup file (nvm, oh-my-zsh) the command was typed after a fixed
  1 s, so it showed up ahead of the startup output and then a second time at the
  prompt. termiHub now waits until the local shell's line editor is reading, or
  until an SSH shell's output has come to rest at a prompt. Nothing extra is
  typed into the shell to find out.
