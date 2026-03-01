import { Public, Tool } from '@nest-mcp/server';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../database/database.service';

const READ_ONLY_PATTERN = /^\s*(SELECT|WITH|EXPLAIN|SHOW|TABLE|VALUES)/i;
const WRITE_PATTERN =
  /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|REPLACE|MERGE|CALL|EXEC|EXECUTE)\b/i;

function isSafeReadOnlyQuery(sql: string): boolean {
  return READ_ONLY_PATTERN.test(sql) && !WRITE_PATTERN.test(sql.toUpperCase());
}

@Injectable()
export class QueryTools {
  private readonly logger = new Logger(QueryTools.name);

  constructor(private readonly db: DatabaseService) {}

  @Tool({
    name: 'execute_sql',
    description:
      'Execute a SQL query against the PostgreSQL database. ' +
      'When POSTGRES_READONLY=true only SELECT, WITH, EXPLAIN, SHOW, TABLE, and VALUES queries are allowed. ' +
      'Returns rows as JSON along with field metadata and row count.',
    parameters: z.object({
      sql: z.string().describe('SQL query to execute'),
      params: z
        .array(z.unknown())
        .optional()
        .describe('Optional parameterized values referenced as $1, $2, … in the query'),
      timeout_ms: z
        .number()
        .optional()
        .default(30000)
        .describe('Statement timeout in milliseconds (default: 30000)'),
    }),
    annotations: { readOnlyHint: false },
  })
  @Public()
  async executeSql(args: { sql: string; params?: unknown[]; timeout_ms?: number }) {
    const { sql, params = [], timeout_ms = 30000 } = args;

    if (this.db.isReadOnly() && !isSafeReadOnlyQuery(sql)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Error: Server is configured in read-only mode. Only SELECT, WITH, EXPLAIN, SHOW, TABLE, and VALUES queries are allowed.',
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await this.db.query(sql, params, { timeoutMs: timeout_ms });
      const output = {
        rows: result.rows,
        rowCount: result.rowCount,
        fields: result.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Query failed: ${message}`);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }

  @Tool({
    name: 'explain_query',
    description:
      'Run EXPLAIN (ANALYZE, BUFFERS) on a SQL query to show the execution plan with actual timing, ' +
      'row counts, and buffer usage. Essential for diagnosing slow queries.',
    parameters: z.object({
      sql: z.string().describe('SQL query to explain'),
      analyze: z
        .boolean()
        .optional()
        .default(true)
        .describe('Actually execute the query to get real timings (default: true)'),
      buffers: z
        .boolean()
        .optional()
        .default(true)
        .describe('Include buffer hit/miss statistics (default: true)'),
      format: z
        .enum(['text', 'json'])
        .optional()
        .default('text')
        .describe(
          "Output format — 'text' for human-readable, 'json' for structured (default: text)",
        ),
    }),
    annotations: { readOnlyHint: true },
  })
  @Public()
  async explainQuery(args: { sql: string; analyze?: boolean; buffers?: boolean; format?: string }) {
    const { sql, analyze = true, buffers = true, format = 'text' } = args;
    const options = [
      `ANALYZE ${analyze}`,
      `BUFFERS ${buffers}`,
      `FORMAT ${format.toUpperCase()}`,
    ].join(', ');
    const explainSql = `EXPLAIN (${options}) ${sql}`;

    try {
      const result = await this.db.query(explainSql, [], { timeoutMs: 60_000 });
      const output =
        format === 'json'
          ? JSON.stringify(result.rows[0], null, 2)
          : result.rows.map((r: Record<string, unknown>) => r['QUERY PLAN']).join('\n');

      return {
        content: [{ type: 'text' as const, text: output }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`EXPLAIN failed: ${message}`);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }
}
