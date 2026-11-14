class UserRepo {
  save() {
    return true;
  }

  findById(id: number) {
    return id;
  }
}

export function repoApi() {
  return UserRepo;
}
