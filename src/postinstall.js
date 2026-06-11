"use strict";

// Best-effort setup on install. Creates the shared user template/prompt/config
// so the first `pbhandover on` in a project has sane defaults. Never throws in a
// way that fails `npm install`; the wrapper in package.json swallows errors.
const { main } = require("./cli");

main(["setup", "--quiet"]).catch(() => {
  // Setup is best effort during postinstall.
});
