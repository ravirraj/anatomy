// export = of an identifier: the module is the class, and only the module as a
// whole is exported — no individual name of it is.
class Connection {
  open(): boolean {
    return true;
  }
}

export = Connection;
