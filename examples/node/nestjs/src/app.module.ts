import {
  Module,
  type DynamicModule,
} from "@nestjs/common";
import type { TrafficWar } from "@trafficwar/node";

import { GreetingService } from "./greeting.service.js";
import { HelloController } from "./hello.controller.js";
import {
  TRAFFICWAR,
  TrafficWarLifecycle,
} from "./trafficwar.provider.js";

@Module({})
export class AppModule {
  static register(trafficwar: TrafficWar): DynamicModule {
    return {
      module: AppModule,
      controllers: [HelloController],
      providers: [
        GreetingService,
        TrafficWarLifecycle,
        {
          provide: TRAFFICWAR,
          useValue: trafficwar,
        },
      ],
    };
  }
}
