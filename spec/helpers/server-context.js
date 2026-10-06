const path = require("path");

// Specs use the current client generation without coupling adapter runtime
// code to a sibling repository or a pinned package dependency.
const serverContext = (overrides = {}) => {
  const { createServerResolver } = require(
    path.join(lumine.packages.resolvePackagePath("ide-client"), "lib", "server-resolver"),
  );
  return { rootPath: process.cwd(), ...overrides, resolver: createServerResolver() };
};

module.exports = { serverContext };
