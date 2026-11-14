function first() {
  function helper() {
    return 1;
  }
  return helper();
}

function second() {
  function helper() {
    return 2;
  }
  return helper();
}

export function twins() {
  return [first(), second()];
}
