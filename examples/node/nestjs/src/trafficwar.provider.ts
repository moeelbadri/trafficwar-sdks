import {
  Inject,
  Injectable,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { TrafficWar } from "@trafficwar/node";

export const TRAFFICWAR = Symbol("TRAFFICWAR");

@Injectable()
export class TrafficWarLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(TRAFFICWAR) private readonly trafficwar: TrafficWar,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.trafficwar.close();
  }
}
