export interface Spawner {
  acquire(userId: string): Promise<number>;
  noteActivity(userId: string): void;
  kick(userId: string): void;
  stopAll(): Promise<void>;
  runningCount(): number;
  startReaper(): () => void;
}

export function createSpawner(options: {
  projectRoot: string;
  usersDir: string;
  deepseekKey?: string;
  maxConcurrent?: number;
  idleMinutes?: number;
  reapIntervalMs?: number;
  nodeExec?: string;
}): Spawner;
