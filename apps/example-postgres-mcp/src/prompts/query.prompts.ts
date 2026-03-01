import { Prompt, Public } from '@nest-mcp/server';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

@Injectable()
export class QueryPrompts {
  @Prompt({
    name: 'analyze_query',
    description:
      'Analyze a PostgreSQL query for performance issues, correctness, and potential improvements. ' +
      'Optionally provide table schema context for deeper analysis.',
    parameters: z.object({
      sql: z.string().describe('SQL query to analyze'),
      context: z
        .string()
        .optional()
        .describe('Optional: table schema (JSON from describe_table) or additional context'),
    }),
  })
  @Public()
  async analyzeQuery(args: { sql: string; context?: string }) {
    const contextSection = args.context ? `\n\nRelevant schema context:\n${args.context}` : '';
    return {
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Please analyze the following PostgreSQL query:

\`\`\`sql
${args.sql}
\`\`\`
${contextSection}

Provide a structured analysis covering:
1. **Correctness** — potential bugs, edge cases, NULL handling
2. **Performance** — missing indexes, full table scans, N+1 patterns, subquery efficiency
3. **Readability** — naming, formatting, CTE vs subquery tradeoffs
4. **Security** — SQL injection risk if query is built from user input
5. **Recommendations** — specific, actionable improvements`,
          },
        },
      ],
    };
  }

  @Prompt({
    name: 'write_query',
    description: 'Generate a PostgreSQL query from a natural language description.',
    parameters: z.object({
      description: z.string().describe('Describe what the query should do'),
      schema: z
        .string()
        .optional()
        .describe('Optional: relevant table schemas (JSON from describe_table or list_tables)'),
      constraints: z
        .string()
        .optional()
        .describe('Optional: constraints such as read-only, max rows, performance requirements'),
    }),
  })
  @Public()
  async writeQuery(args: { description: string; schema?: string; constraints?: string }) {
    const schemaSection = args.schema
      ? `\n\nAvailable schema:\n\`\`\`json\n${args.schema}\n\`\`\``
      : '';
    const constraintsSection = args.constraints ? `\n\nConstraints:\n${args.constraints}` : '';
    return {
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Write a PostgreSQL query that does the following:

${args.description}
${schemaSection}
${constraintsSection}

Requirements:
- Use parameterized placeholders ($1, $2, …) wherever user input is involved
- Prefer CTEs over nested subqueries for readability
- Add inline comments for non-obvious logic
- Ensure the query is correct, efficient, and safe`,
          },
        },
      ],
    };
  }

  @Prompt({
    name: 'optimize_schema',
    description:
      'Review a database schema and provide optimization recommendations for indexes, data types, ' +
      'constraints, and overall structure.',
    parameters: z.object({
      schema_json: z
        .string()
        .describe('Schema description as JSON — use output from describe_table or list_tables'),
      use_case: z
        .string()
        .optional()
        .describe('Optional: primary use case or typical query patterns for the schema'),
    }),
  })
  @Public()
  async optimizeSchema(args: { schema_json: string; use_case?: string }) {
    const useCaseSection = args.use_case
      ? `\n\nPrimary use case / query patterns:\n${args.use_case}`
      : '';
    return {
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Please review the following PostgreSQL schema and provide optimization recommendations:

\`\`\`json
${args.schema_json}
\`\`\`
${useCaseSection}

Analyze and recommend improvements for:
1. **Indexes** — missing, redundant, or poorly chosen indexes
2. **Data types** — storage efficiency and type correctness
3. **Constraints** — NOT NULL, CHECK, UNIQUE opportunities
4. **Normalization** — denormalization tradeoffs for read-heavy workloads
5. **Partitioning** — for large tables that would benefit from it
6. **Documentation** — missing comments on tables and columns`,
          },
        },
      ],
    };
  }
}
