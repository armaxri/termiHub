### Added

- Terminal inline images: SIXEL graphics and the iTerm2 inline image protocol
  (`imgcat`, `img2sixel`, `chafa -f sixel`) now render as pictures instead of
  escape-sequence noise. Toggle under Settings > Terminal > Inline Images (on
  by default). Each terminal caps image memory (2048 × 2048 px per image,
  32 MB image store, 8 MB per raw image sequence) so hostile output cannot
  exhaust memory; images are not kept across reconnects (PROD-057, #3439).
