const path = require("path");

// Specs use the current client generation without coupling adapter runtime
// code to a sibling repository or a pinned package dependency.
const serverContext = (overrides = {}) => {
  const { managedServer = null, getManagedServer = () => managedServer, ...context } = overrides;
  const { createServerResolver } = require(
    path.join(lumine.packages.resolvePackagePath("ide-client"), "lib", "server-resolver"),
  );
  let read = false;
  let install;
  let error;
  return {
    rootPath: process.cwd(),
    ...context,
    resolver: createServerResolver(),
    getManagedServer() {
      if (!read) {
        read = true;
        try {
          install = getManagedServer();
        } catch (failure) {
          error = failure;
        }
      }
      if (error) throw error;
      return install;
    },
  };
};

module.exports = { serverContext };
