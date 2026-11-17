import { Module } from "@nestjs/common";

import { ConnectionLifecycleCoordinator } from "./connection-lifecycle.coordinator.ts";
import { ConnectionRepository } from "./connection.repository.ts";

@Module({
	providers: [ConnectionLifecycleCoordinator, ConnectionRepository],
	exports: [ConnectionLifecycleCoordinator, ConnectionRepository],
})
export class ConnectionStoreModule {}
