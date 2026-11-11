### Changed

- While a tab waits to reconnect, the reconnect strip now says why the last attempt
  failed, for example that the serial port is missing or that a different device is on
  it. Screen readers hear the reason when it changes, not with every attempt (#5395).
- An agent tab whose first session start fails now retries on the same schedule as every
  other reconnect: up to 10 attempts with growing waits, shown as "Attempt n of 10 · next
  try in Ns" with the last failure. It used to retry 5 times after a fixed 5.5 s each and
  showed no maximum (#5397).
