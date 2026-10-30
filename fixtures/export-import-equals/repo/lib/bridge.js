// Plain CommonJS interoperating with TypeScript modules: the require lands on
// the .ts file.
const settings = require("./config");

module.exports.url = function url() {
  return settings.host + ":" + settings.port;
};
