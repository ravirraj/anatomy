const { add } = require("./math");
const fs = require("fs");

module.exports.run = function run(label) {
  const total = add(2, 3);
  return label + " " + total + " " + typeof fs.statSync;
};
