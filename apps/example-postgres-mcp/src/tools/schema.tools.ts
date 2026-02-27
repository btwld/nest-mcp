import { Public, Tool } from '@btwld/mcp-server';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class SchemaTools {
  private readonly logger = new Logger(SchemaTools.name);

  constructor(private readonly db: DatabaseService) {}

  @Tool({
    name: 'list_schemas',
    description:
      'List all schemas in the PostgreSQL database with table/view counts and total size. ' +
      'System schemas (pg_catalog, information_schema, etc.) are excluded by default.',
    parameters: z.object({
      include_system: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include system schemas like pg_catalog and information_schema (default: false)'),
    }),
    annotations: { readOnlyHint: true },
  })
  @Public()
  async listSchemas(args: { include_system?: boolean }) {
    const { include_system = false } = args;
    const systemFilter = include_system
      ? ''
      : `AND s.schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         AND s.schema_name NOT LIKE 'pg_%'`;

    const sql = `
      SELECT
        s.schema_name,
        s.schema_owner,
        pg_size_pretty(SUM(pg_total_relation_size(c.oid))) AS total_size,
        COUNT(DISTINCT c.oid) FILTER (WHERE c.relkind = 'r') AS table_count,
        COUNT(DISTINCT c.oid) FILTER (WHERE c.relkind = 'v') AS view_count,
        COUNT(DISTINCT c.oid) FILTER (WHERE c.relkind = 'm') AS matview_count
      FROM information_schema.schemata s
      LEFT JOIN pg_class c ON c.relnamespace = (
        SELECT oid FROM pg_namespace WHERE nspname = s.schema_name
      )
      WHERE 1=1 ${systemFilter}
      GROUP BY s.schema_name, s.schema_owner
      ORDER BY s.schema_name
    `;

    try {
      const result = await this.db.query(sql);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.rows, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`list_schemas failed: ${message}`);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }

  @Tool({
    name: 'list_tables',
    description:
      'List all tables, views, and materialized views in a schema with estimated row counts and sizes.',
    parameters: z.object({
      schema: z.string().optional().default('public').describe("Schema name (default: 'public')"),
      include_views: z
        .boolean()
        .optional()
        .default(true)
        .describe('Include views and materialized views (default: true)'),
    }),
    annotations: { readOnlyHint: true },
  })
  @Public()
  async listTables(args: { schema?: string; include_views?: boolean }) {
    const { schema = 'public', include_views = true } = args;
    const relkindFilter = include_views ? `c.relkind IN ('r', 'v', 'm')` : `c.relkind = 'r'`;

    const sql = `
      SELECT
        c.relname AS table_name,
        CASE c.relkind
          WHEN 'r' THEN 'table'
          WHEN 'v' THEN 'view'
          WHEN 'm' THEN 'materialized_view'
        END AS type,
        pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
        pg_size_pretty(pg_relation_size(c.oid)) AS data_size,
        c.reltuples::bigint AS estimated_rows,
        obj_description(c.oid, 'pg_class') AS comment
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND ${relkindFilter}
      ORDER BY c.relname
    `;

    try {
      const result = await this.db.query(sql, [schema]);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.rows, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`list_tables failed: ${message}`);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }

  @Tool({
    name: 'describe_table',
    description:
      'Get the full structure of a table: columns with data types and defaults, ' +
      'primary keys, unique and foreign key constraints, and indexes.',
    parameters: z.object({
      table: z.string().describe('Table name'),
      schema: z.string().optional().default('public').describe("Schema name (default: 'public')"),
    }),
    annotations: { readOnlyHint: true },
  })
  @Public()
  async describeTable(args: { table: string; schema?: string }) {
    const { table, schema = 'public' } = args;

    try {
      const [columns, constraints, indexes] = await Promise.all([
        this.getColumns(schema, table),
        this.getConstraints(schema, table),
        this.getIndexes(schema, table),
      ]);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ schema, table, columns, constraints, indexes }, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`describe_table failed: ${message}`);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }

  @Tool({
    name: 'list_indexes',
    description:
      'List all indexes for a table with their definitions, sizes, and usage statistics ' +
      '(scan count, tuples read/fetched) from pg_stat_user_indexes.',
    parameters: z.object({
      table: z.string().describe('Table name'),
      schema: z.string().optional().default('public').describe("Schema name (default: 'public')"),
    }),
    annotations: { readOnlyHint: true },
  })
  @Public()
  async listIndexes(args: { table: string; schema?: string }) {
    const { table, schema = 'public' } = args;

    const sql = `
      SELECT
        i.relname AS index_name,
        ix.indisprimary AS is_primary,
        ix.indisunique AS is_unique,
        ix.indisvalid AS is_valid,
        pg_size_pretty(pg_relation_size(i.oid)) AS index_size,
        COALESCE(s.idx_scan, 0) AS scans,
        COALESCE(s.idx_tup_read, 0) AS tuples_read,
        COALESCE(s.idx_tup_fetch, 0) AS tuples_fetched,
        pg_get_indexdef(ix.indexrelid) AS definition
      FROM pg_index ix
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = ix.indexrelid
      WHERE t.relname = $1
        AND n.nspname = $2
      ORDER BY ix.indisprimary DESC, i.relname
    `;

    try {
      const result = await this.db.query(sql, [table, schema]);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.rows, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`list_indexes failed: ${message}`);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }

  @Tool({
    name: 'get_db_stats',
    description:
      'Get overall database statistics: size, connection count, cache hit ratio, ' +
      'transaction stats, and top tables by size.',
    parameters: z.object({}),
    annotations: { readOnlyHint: true },
  })
  @Public()
  async getDbStats() {
    const queries = {
      database: `
        SELECT
          current_database() AS database_name,
          pg_size_pretty(pg_database_size(current_database())) AS database_size,
          (SELECT count(*) FROM pg_stat_activity WHERE state = 'active') AS active_connections,
          (SELECT count(*) FROM pg_stat_activity) AS total_connections,
          (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_connections
      `,
      cacheHitRatio: `
        SELECT
          round(
            sum(blks_hit)::numeric / NULLIF(sum(blks_hit) + sum(blks_read), 0) * 100, 2
          ) AS cache_hit_ratio_pct
        FROM pg_stat_database
        WHERE datname = current_database()
      `,
      topTablesBySize: `
        SELECT
          schemaname,
          tablename,
          pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) AS total_size,
          pg_size_pretty(pg_relation_size(schemaname || '.' || tablename)) AS data_size,
          n_live_tup AS live_rows,
          n_dead_tup AS dead_rows
        FROM pg_stat_user_tables
        ORDER BY pg_total_relation_size(schemaname || '.' || tablename) DESC
        LIMIT 10
      `,
      longRunningQueries: `
        SELECT
          pid,
          now() - pg_stat_activity.query_start AS duration,
          query,
          state
        FROM pg_stat_activity
        WHERE (now() - pg_stat_activity.query_start) > interval '5 seconds'
          AND state != 'idle'
        ORDER BY duration DESC
        LIMIT 5
      `,
    };

    try {
      const [database, cacheHit, topTables, longRunning] = await Promise.all([
        this.db.query(queries.database),
        this.db.query(queries.cacheHitRatio),
        this.db.query(queries.topTablesBySize),
        this.db.query(queries.longRunningQueries),
      ]);

      const stats = {
        database: database.rows[0],
        cache_hit_ratio: cacheHit.rows[0],
        top_tables_by_size: topTables.rows,
        long_running_queries: longRunning.rows,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(stats, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`get_db_stats failed: ${message}`);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }

  private async getColumns(schema: string, table: string) {
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
        c.ordinal_position,
        col_description(
          (SELECT oid FROM pg_class WHERE relname = $2
            AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)),
          c.ordinal_position
        ) AS comment
      FROM information_schema.columns c
      WHERE c.table_schema = $1
        AND c.table_name = $2
      ORDER BY c.ordinal_position
      `,
      [schema, table],
    );
    return result.rows;
  }

  private async getConstraints(schema: string, table: string) {
    const result = await this.db.query(
      `
      SELECT
        tc.constraint_name,
        tc.constraint_type,
        kcu.column_name,
        ccu.table_schema AS foreign_table_schema,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name,
        rc.update_rule,
        rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
      LEFT JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
      LEFT JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = rc.unique_constraint_name
      WHERE tc.table_schema = $1
        AND tc.table_name = $2
      ORDER BY tc.constraint_type, tc.constraint_name, kcu.ordinal_position
      `,
      [schema, table],
    );
    return result.rows;
  }

  private async getIndexes(schema: string, table: string) {
    const result = await this.db.query(
      `
      SELECT
        i.relname AS index_name,
        ix.indisprimary AS is_primary,
        ix.indisunique AS is_unique,
        pg_get_indexdef(ix.indexrelid) AS definition
      FROM pg_index ix
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE t.relname = $1
        AND n.nspname = $2
      ORDER BY ix.indisprimary DESC, i.relname
      `,
      [table, schema],
    );
    return result.rows;
  }
}
