## Changed

- The Settings panels, Network Tools panels, file browser toolbar/row actions, terminal search bar, and update notification now use the shared button component — consistent styling, focus, and motion across the app. Actions that previously failed silently (opening download pages, exporting/importing config, saving/waking Wake-on-LAN devices, refreshing monitors) now surface a toast on error, and long-running probes show the button's pending state. Icon-only buttons and the search-bar toggles gained accessible labels / pressed state.
