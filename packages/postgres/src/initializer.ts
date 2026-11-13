/**
 * SQL migration runner.
 *
 * Statements are split with a small state machine that understands single quotes, double
 * quotes, line comments, block comments and PostgreSQL dollar-quoted blocks ($$ ... $$ and
 * $tag$ ... $tag$). That matters because `DO $$ BEGIN ... END $$;` blocks contain
 * semicolons and would otherwise be torn apart.
 */

import { readFile } from 'node:fs/promises';
import pg from 'pg';

export interface SqlExecutionResult {
  file: string;
  statements: number;
  durationMs: number;
  executed: string[];
}

export interface SchemaVerification {
  tables: string[];
  rlsEnabledTables: string[];
  constraintCount: number;
  errors: string[];
}

export class SqlExecutionError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly statement: string
  ) {
    super(message);
    this.name = 'SqlExecutionError';
  }
}

export function splitSqlStatements(content: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;

  while (i < content.length) {
    const ch = content[i];
    const next = content[i + 1];

    // line comment
    if (ch === '-' && next === '-') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }

    // block comment
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // single-quoted string
    if (ch === "'") {
      current += ch;
      i++;
      while (i < content.length) {
        if (content[i] === "'" && content[i + 1] === "'") {
          current += "''";
          i += 2;
          continue;
        }
        current += content[i];
        if (content[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // double-quoted identifier
    if (ch === '"') {
      current += ch;
      i++;
      while (i < content.length) {
        current += content[i];
        if (content[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // dollar-quoted block
    if (ch === '$') {
      const tagMatch = /^\$[A-Za-z_0-9]*\$/.exec(content.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = content.indexOf(tag, i + tag.length);
        if (end === -1) {
          current += content.slice(i);
          i = content.length;
          continue;
        }
        current += content.slice(i, end + tag.length);
        i = end + tag.length;
        continue;
      }
    }

    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

export class MigrationRunner {
  constructor(private readonly connect: () => Promise<pg.Client>) {}

  async applyFile(filePath: string): Promise<SqlExecutionResult> {
    const content = await readFile(filePath, 'utf8');
    const statements = splitSqlStatements(content);
    const started = Date.now();
    const executed: string[] = [];

    const client = await this.connect();
    try {
      for (const statement of statements) {
        try {
          await client.query(statement);
          executed.push(statement.split('\n')[0].slice(0, 120));
        } catch (error) {
          throw new SqlExecutionError(
            `Migration ${filePath} failed: ${(error as Error).message}`,
            filePath,
            statement
          );
        }
      }
    } finally {
      await client.end().catch(() => undefined);
    }

    return { file: filePath, statements: statements.length, durationMs: Date.now() - started, executed };
  }
}

export async function verifySchema(client: pg.Client): Promise<SchemaVerification> {
  const errors: string[] = [];
  const tables: string[] = [];
  const rlsEnabledTables: string[] = [];
  let constraintCount = 0;

  try {
    const tableResult = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
    );
    tables.push(...tableResult.rows.map((r) => r.tablename));

    const rlsResult = await client.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relrowsecurity = true`
    );
    rlsEnabledTables.push(...rlsResult.rows.map((r) => r.relname));

    const constraintResult = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'public'`
    );
    constraintCount = Number(constraintResult.rows[0]?.count ?? '0');
  } catch (error) {
    errors.push((error as Error).message);
  }

  return { tables, rlsEnabledTables, constraintCount, errors };
}
