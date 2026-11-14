class UserService {
  public validate() {
    return true;
  }

  private normalize() {
    return 1;
  }

  protected check() {
    return 2;
  }

  static create() {
    return new UserService();
  }
}

export function users() {
  return UserService.create();
}
