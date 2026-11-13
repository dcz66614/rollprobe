/**
 * Resource bookkeeping for a single campaign run.
 *
 * Rollprobe never deletes anything it did not create. Every container, network and
 * volume that the backend provisions is registered here first, and cleanup walks this
 * registry only.
 */

export type ResourceType = 'container' | 'network' | 'volume' | 'process' | 'port' | 'directory';

export interface ResourceRecord {
  type: ResourceType;
  identifier: string;
  createdAt: string;
  meta?: Record<string, string>;
}

export interface DatabaseInstance {
  /** Logical id, also used as the run label. */
  id: string;
  containerName: string;
  /** Real 64 hex character container id reported by the engine. */
  containerId: string;
  networkName: string;
  volumeName: string;
  host: string;
  port: number;
  database: string;
  /** Non-superuser role used by the applications under test. */
  appUser: string;
  appPassword: string;
  /** Independent non-superuser role used by the observer / oracle. */
  observerUser: string;
  observerPassword: string;
  /** Admin role, only used by the migration runner. */
  adminUser: string;
  adminPassword: string;
  createdAt: string;
  postgresVersion: string;
  postgresMajor: number;
}

export interface DatabaseCapabilities {
  supportsDocker: boolean;
  dockerVersion?: string;
  engineReachable: boolean;
  error?: string;
}

export class ResourceRegistry {
  readonly resources: ResourceRecord[] = [];

  register(type: ResourceType, identifier: string, meta?: Record<string, string>): ResourceRecord {
    const record: ResourceRecord = {
      type,
      identifier,
      createdAt: new Date().toISOString(),
      ...(meta ? { meta } : {}),
    };
    this.resources.push(record);
    return record;
  }

  list(type?: ResourceType): ResourceRecord[] {
    return type ? this.resources.filter((r) => r.type === type) : [...this.resources];
  }

  remove(type: ResourceType, identifier: string): void {
    const idx = this.resources.findIndex((r) => r.type === type && r.identifier === identifier);
    if (idx >= 0) this.resources.splice(idx, 1);
  }
}

export class EnvironmentError extends Error {
  constructor(
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = 'EnvironmentError';
  }
}
