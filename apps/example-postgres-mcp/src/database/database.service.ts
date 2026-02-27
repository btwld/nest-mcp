import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient, QueryResult } from 'pg';

export interface QueryOptions {
  timeoutMs?: number;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool: Pool | null = null;

  private get readOnly(): boolean {
    return process.env['POSTGRES_READONLY']?.toLowerCase() === 'true';
  }

  onModuleInit(): void {
    const connectionString =
      process.env['DATABASE_URL'] ||
      process.env['POSTGRES_URL'] ||
      this.buildConnectionString();

    this.pool = new Pool({
      connectionString,
      max: parseInt(process.env['POSTGRES_MAX_CONNECTIONS'] ?? '10', 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    this.pool.on('error', (err) => {
      this.logger.error(`Unexpected pool error: ${err.message}`);
    });

    this.logger.log(`Database pool initialized (read-only: ${this.readOnly})`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.logger.log('Database pool closed');
    }
  }

  isReadOnly(): boolean {
    return this.readOnly;
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
    options: QueryOptions = {},
  ): Promise<QueryResult<T>> {
    if (!this.pool) {
      throw new Error('Database pool not initialized');
    }

    const client: PoolClient = await this.pool.connect();
    try {
      if (options.timeoutMs) {
        await client.query(`SET statement_timeout = ${options.timeoutMs}`);
      }
      return await client.query<T>(sql, params);
    } finally {
      client.release();
    }
  }

  private buildConnectionString(): string {
    const host = process.env['POSTGRES_HOST'] ?? 'localhost';
    const port = process.env['POSTGRES_PORT'] ?? '5432';
    const database = process.env['POSTGRES_DATABASE'] ?? process.env['POSTGRES_DB'] ?? 'postgres';
    const user = process.env['POSTGRES_USER'] ?? process.env['POSTGRES_USERNAME'] ?? 'postgres';
    const password = process.env['POSTGRES_PASSWORD'] ?? '';
    return `postgresql://${user}:${password}@${host}:${port}/${database}`;
  }
}
