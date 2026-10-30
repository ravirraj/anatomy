import { Injectable } from "@nestjs/common";

@Injectable()
export class UsersService {
  all(): string[] {
    return ["ada"];
  }
}
