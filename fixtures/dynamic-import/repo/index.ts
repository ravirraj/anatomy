// One specifier is written in the syntax; the other is computed at runtime.
export async function load() {
  const direct = await import("./lazy");
  const name = "./loose";
  const computed = await import(name);
  return direct.go() + computed.roll();
}
