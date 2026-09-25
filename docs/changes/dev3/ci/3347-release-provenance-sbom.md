### Security

- Release downloads are now verifiable: every installer, agent binary and SBOM
  attached to a GitHub release carries a signed build provenance attestation
  tying it to the release workflow run, commit and tag. Check any download with
  `gh attestation verify <file> --repo armaxri/termiHub`.
- Each release now ships CycloneDX software bills of materials for the desktop
  app, the remote agent, the RDP sidecar and the frontend
  (`termiHub-<version>-sbom-*.cdx.json`).
