### Fixed

- A re-opened persistent session no longer shows as ended while it runs when the end of its
  previous connection is reported late. (#6032)
- Opening one persistent session from two places at the same time (two windows, or a restored tab
  and a click) no longer leaves a tab that shows no output. (#6033)
