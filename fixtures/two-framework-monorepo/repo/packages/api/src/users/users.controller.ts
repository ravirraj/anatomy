import { Controller, Get, Post } from "@nestjs/common";
import { UsersService } from "./users.service";

@Controller("users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list() {
    return this.users.all();
  }

  @Post()
  create(_body: unknown) {
    return { created: true };
  }
}
