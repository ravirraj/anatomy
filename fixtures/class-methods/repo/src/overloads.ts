class Store {
  save(value: string): string;
  save(value: number): number;
  save(value: unknown) {
    return value;
  }
}

class Other {
  save() {
    return "other";
  }
}

export function stores() {
  return [new Store(), new Other()];
}
