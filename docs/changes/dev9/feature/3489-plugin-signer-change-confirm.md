### Security

- Updating or reinstalling a plugin now checks that the new package is signed
  by the same key as the installed copy. If the signing key changed, or a
  signed plugin would be replaced by an unsigned package, termiHub stops and
  shows a danger-styled confirmation with both key fingerprints; the replace
  only goes ahead after you tick an acknowledgement and click the confirm
  button (Enter does not confirm). This covers manual installs and installs
  started from the plugin update check. A key change that is also a downgrade
  is confirmed in one prompt (#3489).
