const path = require("path");
const { createRequire } = require("module");
const { guardCompletionDocumentation } = require("./native-documentation");

const [sdk, pluginManifest, ...args] = process.argv.slice(2);
const ts = require(path.join(sdk, "typescript.js"));
const selected = createRequire(pluginManifest);
const vueFactory = selected("@vue/typescript-plugin");
const hostRequire = ts.sys.require;
ts.sys.require = (directory, name) => {
  if (name !== "@vue/typescript-plugin") return hostRequire(directory, name);
  return {
    module: (modules) => {
      const vue = vueFactory(modules);
      return {
        ...vue,
        create(info) {
          guardCompletionDocumentation(info.languageService);
          return vue.create(info);
        },
      };
    },
    modulePath: selected.resolve("@vue/typescript-plugin"),
  };
};
const entry = path.join(sdk, "tsserver.js");
process.argv = [process.argv[0], entry, ...args];
require(entry);
