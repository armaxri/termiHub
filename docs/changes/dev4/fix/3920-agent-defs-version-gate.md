### Fixed

- Agent: the remote agent's saved connections (`connections.json`) now carry a schema version. An older agent can no longer overwrite connections a newer agent saved: it leaves the file untouched and refuses changes with a clear "written by a newer version" error (#3920).
