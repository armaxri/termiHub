### Fixed

- Connection editor: **Test** now validates connections whose secret is not typed into
  the form. It uses the password saved in the credential store (unlocking the store
  first if needed), or prompts for the password / SSH key passphrase — the same as
  Save & Connect — without saving the connection, storing the entered secret, or
  opening a tab. Dismissing the prompt cancels the test instead of reporting an
  authentication failure (#3284).
