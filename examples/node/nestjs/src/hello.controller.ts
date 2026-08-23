import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Req,
} from "@nestjs/common";
import type { Request } from "express";

import {
  GreetingService,
  type Greeting,
} from "./greeting.service.js";

@Controller("hello")
export class HelloController {
  constructor(
    @Inject(GreetingService) private readonly greetings: GreetingService,
  ) {}

  @Get(":name")
  hello(@Param("name") name: string, @Req() request: Request): Greeting {
    const greeting = this.greetings.findGreeting(name, request.method);
    if (!greeting) {
      throw new NotFoundException("Greeting not found");
    }
    return greeting;
  }
}
