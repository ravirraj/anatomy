// import x = require("y") is the declaration spelling of require(): one
// import edge per specifier, and the call inside it is not seen twice.
import config = require("../lib/config");
import Connection = require("../lib/helper");

export function address(): string {
  return Connection.open() ? config.host + ":" + config.port : "closed";
}
