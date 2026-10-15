### Added

- Plugin manifests can name folders inside your home or config folder
  portably: a `filesystemPaths` entry may start with `${home}` or `${config}`
  (for example `${home}/.kube`). termiHub replaces the placeholder with your
  own folder when the plugin loads, then checks the result like any other
  entry. The install dialog and the plugin's access summary show both the
  declared entry and the real folder it resolves to.

### Security

- Only `${home}` and `${config}` are recognised, and only as the first part of
  an entry. Any other placeholder, a bare `${home}` or `${config}`, and `..`
  or other ambiguous segments after a placeholder are rejected. A resolved
  folder that leaves its placeholder's folder through a symlink is refused.
  Native-plugin trust is bound to the resolved folder, so if a placeholder
  resolves somewhere else later, termiHub asks for trust again.
