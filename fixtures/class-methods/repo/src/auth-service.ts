export class AuthService {
  verify() {
    return "ok";
  }

  revoke(token: string) {
    return !token;
  }
}
