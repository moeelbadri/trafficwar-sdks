import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
} from "@nestjs/common";

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
  hello(@Param("name") name: string): Greeting {
    const greeting = this.greetings.findGreeting(name);
    if (!greeting) {
      throw new NotFoundException("Greeting not found");
    }
    return greeting;
  }
}
