function outerFunction() {
  function innerFunction() {
    return true;
  }

  return innerFunction();
}

export function run() {
  return outerFunction();
}
