# web-platform-tests URL data

`urltestdata.json`, `setters_tests.json`, `toascii.json` and `percent-encoding.json` from the
[web-platform-tests](https://github.com/web-platform-tests/wpt/tree/master/url/resources)
(3-Clause BSD license), as ada-url/ada carries them (`tests/wpt`, commit
`2464f98f87c1ed031186919da0a2c15e728f1729`). `tests/programs/url-wpt.js` runs every case and
prints the results, which must match Node's (not the files' expectations: Node, whose URL is Ada
2.9.2, differs from the newest tests in a few cases).
