### Fixed

- A re-opened persistent session whose saved scrollback was empty is no longer shown as ended
  when the end of its previous connection is reported late. (#6110)
- When another computer holds a persistent session, every tab that opens it says so and offers
  Reclaim, not only the first. (#6110)
