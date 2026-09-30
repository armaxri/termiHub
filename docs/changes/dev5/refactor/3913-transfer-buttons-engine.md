### Fixed

- **Uploading a file picked on Windows keeps its file name.** The file browser's
  Upload button named the remote copy after the whole Windows path (for example
  `C:\Users\me\data.csv`) instead of `data.csv`. Upload, Download, dropping
  files onto the browser and dragging files out now all use the same copy
  engine as paste and the transfer view (#3913).
