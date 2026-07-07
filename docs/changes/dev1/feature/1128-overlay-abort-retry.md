## Added

- The terminal connection overlay now offers an **Abort** button while a connection is being established (the "Connecting…", "Waiting for agent…", and auto-retry states). Abort stops the in-flight attempt and leaves the tab on a retryable "Connection failed" state — unlike **Cancel**, which still closes the whole tab. This lets you interrupt a slow or wrong connect and retry in place without losing the tab.
- The "Waiting for agent…" and auto-retry overlays now offer a **Retry now** button that forces an immediate reconnect instead of waiting out the retry delay.

## Changed

- The connection overlay's action buttons now use the shared button primitive for consistent styling. As part of this, the failed-state **Cancel** button changes from an outlined button to a quieter ghost button, keeping the emphasis on **Retry**.
