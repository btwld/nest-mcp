import { Public, Resource, ResourceTemplate } from '@btwld/mcp-server';
import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class SchemaResources {
  private readonly logger = new Logger(SchemaResources.name);

  constructor(private readonly db: DatabaseService) {}

  @Resource({
    uri: 'postgres://schemas',
    name: 'Database Schemas',
    description: 'List of all non-system schemas in the connected PostgreSQL database',
    mimeType: 'application/json',
  })
  @Public()
  async getSchemas() {
    try {
      const result = await this.db.query(`
        SELECT schema_name, schema_owner
        FROM information_schema.schemata
        WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND schema_name NOT LIKE 'pg_%'
        ORDER BY schema_name
      `);
      return {
        contents: [
          {
            uri: 'postgres://schemas',
            mimeType: 'application/json',
            text: JSON.stringify(result.rows, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`getSchemas resource failed: ${message}`);
      return {
        contents: [
          {
            uri: 'postgres://schemas',
            mimeType: 'application/json',
            text: JSON.stringify({ error: message }),
          },
        ],
      };
    }
  }

  @ResourceTemplate({
    uriTemplate: 'postgres://schema/{schema}/tables',
    name: 'Schema Tables',
    description: 'List of tables and views in a specific schema',
    mimeType: 'application/json',
  })
  @Public()
  async getSchemaTables(uri: URL, params: { schema: string }) {
    const { schema } = params;
    try {
      const result = await this.db.query(
        `
        SELECT
          c.relname AS table_name,
          CASE c.relkind
            WHEN 'r' THEN 'table'
            WHEN 'v' THEN 'view'
            WHEN 'm' THEN 'materialized_view'
          END AS type,
          c.reltuples::bigint AS estimated_rows,
          pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND c.relkind IN ('r', 'v', 'm')
        ORDER BY c.relname
        `,
        [schema],
      );
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(result.rows, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ error: message }),
          },
        ],
      };
    }
  }

  @ResourceTemplate({
    uriTemplate: 'postgres://table/{schema}/{table}',
    name: 'Table Structure',
    description: 'Column definitions, data types, nullability, and defaults for a specific table',
    mimeType: 'application/json',
  })
  @Public()
  async getTableStructure(uri: URL, params: { schema: string; table: string }) {
    const { schema, table } = params;
    try {
      const result = await this.db.query(
        `
        SELECT
          c.column_name,
          c.data_type,
          c.udt_name,
          c.character_maximum_length,
          c.numeric_precision,
          c.numeric_scale,
          c.is_nullable,
          c.column_default,
          c.ordinal_position
        FROM information_schema.columns c
        WHERE c.table_schema = $1
          AND c.table_name = $2
        ORDER BY c.ordinal_position
        `,
        [schema, table],
      );
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ schema, table, columns: result.rows }, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ error: message }),
          },
        ],
      };
    }
  }
}
