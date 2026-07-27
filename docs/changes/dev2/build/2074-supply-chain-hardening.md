### Security

- Hardened the dependency supply chain (#2074):
  - Bumped `anyhow` to 1.0.104, clearing RUSTSEC-2026-0190 (unsoundness in
    `Error::downcast_mut`).
  - Bumped the bundled `crypto-bigint` (SSH auth path, transitive via russh) off
    the yanked 0.7.3 to the non-yanked 0.7.5.
  - Bumped the DOMPurify override to `>=3.4.12 <4`.
